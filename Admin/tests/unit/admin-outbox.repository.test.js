'use strict';

const adminOutboxRepository = require('../../src/repositories/admin-outbox.repository');

describe('Phase 20 Unit: Admin Outbox Repository', () => {
  let mockQuery;

  beforeEach(() => {
    adminOutboxRepository.constructor.resetMockResolver();
    mockQuery = jest.fn();
    jest.spyOn(adminOutboxRepository, 'query').mockImplementation(mockQuery);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    adminOutboxRepository.constructor.resetMockResolver();
  });

  describe('1. createEvent', () => {
    it('persists an outbox event with sanitized payload and PENDING status', async () => {
      const fakeRow = {
        id: 'outbox-uuid-1',
        event_type: 'NOTIFICATION_DISPATCH_REQUESTED',
        aggregate_type: 'NOTIFICATION',
        aggregate_id: 'notif-uuid-1',
        payload: { title: 'Booking confirmed', password: '[REDACTED]' },
        status: 'PENDING',
        max_retries: 5,
        retry_count: 0,
      };

      mockQuery.mockResolvedValueOnce({ rows: [fakeRow] });

      const result = await adminOutboxRepository.createEvent({
        eventType: 'NOTIFICATION_DISPATCH_REQUESTED',
        aggregateType: 'NOTIFICATION',
        aggregateId: 'notif-uuid-1',
        payload: { title: 'Booking confirmed', password: 'secretpassword123' },
        maxRetries: 5,
      });

      expect(result).toEqual(fakeRow);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const sql = mockQuery.mock.calls[0][0];
      const params = mockQuery.mock.calls[0][1];

      expect(sql).toContain('INSERT INTO outbox_events');
      expect(params[0]).toBe('NOTIFICATION_DISPATCH_REQUESTED');
      expect(params[1]).toBe('NOTIFICATION');
      expect(params[2]).toBe('notif-uuid-1');
      // Verify payload was redacted before SQL insertion
      expect(params[3]).toContain('[REDACTED]');
      expect(params[3]).not.toContain('secretpassword123');
      expect(params[4]).toBe(5);
    });

    it('supports mock resolver override for isolated unit testing', async () => {
      adminOutboxRepository.constructor.setMockResolver({
        createEvent: async () => ({ id: 'mocked-id' }),
      });

      const res = await adminOutboxRepository.createEvent({ eventType: 'TEST' });
      expect(res.id).toBe('mocked-id');
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('2. claimEvents (Concurrency-Safe Row Locking)', () => {
    it('executes atomic update with FOR UPDATE SKIP LOCKED and bounds batch size', async () => {
      const fakeClaimed = [
        {
          id: 'job-1',
          event_type: 'NOTIFICATION_DISPATCH_REQUESTED',
          status: 'PROCESSING',
          locked_by: 'worker-node-1',
        },
      ];

      mockQuery.mockResolvedValueOnce({ rows: fakeClaimed });

      const claimed = await adminOutboxRepository.claimEvents({
        batchSize: 200, // Should be bounded to 100 max
        workerId: 'worker-node-1',
        leaseSeconds: 300,
      });

      expect(claimed).toEqual(fakeClaimed);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const sql = mockQuery.mock.calls[0][0];
      const params = mockQuery.mock.calls[0][1];

      expect(sql).toContain('FOR UPDATE SKIP LOCKED');
      expect(sql).toContain('status = \'PROCESSING\'');
      expect(params[0]).toBe(100); // Bounded to max 100
      expect(params[1]).toBe('worker-node-1');
    });

    it('defaults batch size to 10 if invalid or unspecified', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await adminOutboxRepository.claimEvents({ workerId: 'worker-1' });
      expect(mockQuery.mock.calls[0][1][0]).toBe(10);
    });
  });

  describe('3. markProcessed', () => {
    it('updates status to PROCESSED and clears worker lease locks', async () => {
      const processedRow = {
        id: 'job-1',
        status: 'PROCESSED',
        locked_at: null,
        locked_by: null,
      };

      mockQuery.mockResolvedValueOnce({ rows: [processedRow] });

      const res = await adminOutboxRepository.markProcessed('job-1');
      expect(res).toEqual(processedRow);

      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('status = \'PROCESSED\'');
      expect(sql).toContain('locked_at = NULL');
      expect(sql).toContain('locked_by = NULL');
    });
  });

  describe('4. markFailed & Exponential Backoff', () => {
    it('schedules retry with exponential backoff when error is retryable and attempt < max_retries', async () => {
      // First findById call to check retry state
      jest.spyOn(adminOutboxRepository, 'findById').mockResolvedValueOnce({
        id: 'job-1',
        retry_count: 1,
        max_retries: 5,
      });

      const updatedRow = {
        id: 'job-1',
        status: 'PENDING',
        retry_count: 2,
        last_error: 'Network timeout to FCM',
      };
      mockQuery.mockResolvedValueOnce({ rows: [updatedRow] });

      const res = await adminOutboxRepository.markFailed(
        'job-1',
        new Error('Network timeout to FCM with Bearer token_secret_123'),
        { isRetryable: true, baseBackoffMs: 2000, maxBackoffMs: 30000, jitter: false },
      );

      expect(res).toEqual(updatedRow);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const sql = mockQuery.mock.calls[0][0];
      const params = mockQuery.mock.calls[0][1];

      expect(sql).toContain('status = \'PENDING\'');
      expect(sql).toContain('next_retry_at = CURRENT_TIMESTAMP');
      expect(params[1]).toBe(2); // nextRetryCount
      // Verify redaction of Bearer tokens in error persistence
      expect(params[3]).toContain('Bearer [REDACTED]');
      expect(params[3]).not.toContain('token_secret_123');
    });

    it('marks as terminal FAILED (dead-letter) when attempt reaches max_retries', async () => {
      jest.spyOn(adminOutboxRepository, 'findById').mockResolvedValueOnce({
        id: 'job-1',
        retry_count: 4,
        max_retries: 5,
      });

      const terminalRow = { id: 'job-1', status: 'FAILED', retry_count: 5 };
      mockQuery.mockResolvedValueOnce({ rows: [terminalRow] });

      const res = await adminOutboxRepository.markFailed('job-1', 'Transient gateway error', {
        isRetryable: true,
      });

      expect(res).toEqual(terminalRow);
      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('status = \'FAILED\'');
      expect(mockQuery.mock.calls[0][1][1]).toBe(5);
    });

    it('marks as terminal FAILED immediately when error is non-retryable', async () => {
      jest.spyOn(adminOutboxRepository, 'findById').mockResolvedValueOnce({
        id: 'job-2',
        retry_count: 0,
        max_retries: 5,
      });

      const failedRow = { id: 'job-2', status: 'FAILED', retry_count: 1 };
      mockQuery.mockResolvedValueOnce({ rows: [failedRow] });

      const res = await adminOutboxRepository.markFailed('job-2', 'Invalid payload schema', {
        isRetryable: false,
      });

      expect(res).toEqual(failedRow);
      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('status = \'FAILED\'');
      expect(mockQuery.mock.calls[0][1][1]).toBe(1);
    });

    it('returns null if target event record does not exist', async () => {
      jest.spyOn(adminOutboxRepository, 'findById').mockResolvedValueOnce(null);

      const res = await adminOutboxRepository.markFailed('missing-id', 'Some error');
      expect(res).toBeNull();
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('5. recoverStaleJobs', () => {
    it('recovers jobs stuck in PROCESSING past lease duration back to PENDING', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'stale-job-1' }, { id: 'stale-job-2' }],
      });

      const recovered = await adminOutboxRepository.recoverStaleJobs(300);
      expect(recovered).toEqual(['stale-job-1', 'stale-job-2']);

      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('status = \'PROCESSING\'');
      expect(sql).toContain('status = \'PENDING\'');
      expect(sql).toContain('FOR UPDATE SKIP LOCKED');
      expect(mockQuery.mock.calls[0][1][0]).toBe('300');
    });
  });

  describe('6. releaseWorkerLeases', () => {
    it('releases all leases held by workerId on clean shutdown', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 3 });

      const count = await adminOutboxRepository.releaseWorkerLeases('worker-pid-1');
      expect(count).toBe(3);

      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('WHERE status = \'PROCESSING\' AND locked_by = $1');
      expect(mockQuery.mock.calls[0][1][0]).toBe('worker-pid-1');
    });

    it('returns 0 if workerId is empty or null', async () => {
      const count = await adminOutboxRepository.releaseWorkerLeases(null);
      expect(count).toBe(0);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('7. getQueueStats', () => {
    it('aggregates operational queue statistics', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            pending_count: '15',
            processing_count: '3',
            stale_count: '1',
            processed_count: '150',
            dead_letter_count: '2',
            retryable_failed_count: '4',
            total_events: '175',
            oldest_pending_at: '2026-09-27T08:00:00Z',
          },
        ],
      });

      const stats = await adminOutboxRepository.getQueueStats(300);
      expect(stats).toEqual({
        pendingCount: 15,
        processingCount: 3,
        staleCount: 1,
        processedCount: 150,
        deadLetterCount: 2,
        retryableFailedCount: 4,
        totalEvents: 175,
        oldestPendingAt: '2026-09-27T08:00:00Z',
      });
    });
  });

  describe('8. listOperationalEvents & cleanupProcessedEvents', () => {
    it('lists operational events with parameterized filtering and pagination', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'evt-1',
            event_type: 'NOTIFICATION_DISPATCH_REQUESTED',
            aggregate_type: 'NOTIFICATION',
            aggregate_id: 'n-1',
            status: 'PENDING',
            retry_count: 0,
            max_retries: 5,
            next_retry_at: '2026-09-27T09:00:00Z',
            last_error: null,
            processed_at: null,
            created_at: '2026-09-27T09:00:00Z',
            locked_at: null,
            locked_by: null,
          },
        ],
      });

      const events = await adminOutboxRepository.listOperationalEvents({
        status: 'PENDING',
        limit: 10,
        offset: 0,
      });

      expect(events.length).toBe(1);
      expect(events[0].id).toBe('evt-1');
      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('status = $1');
      expect(sql).toContain('LIMIT $2 OFFSET $3');
    });

    it('cleanupProcessedEvents removes old processed rows and preserves active data', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 42 });

      const purged = await adminOutboxRepository.cleanupProcessedEvents(30);
      expect(purged).toBe(42);

      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('DELETE FROM outbox_events');
      expect(sql).toContain('status = \'PROCESSED\'');
      expect(mockQuery.mock.calls[0][1][0]).toBe('30');
    });
  });
});
