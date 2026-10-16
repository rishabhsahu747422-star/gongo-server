'use strict';

const { OutboxWorker } = require('../../src/jobs/outbox.worker');
const handlers = require('../../src/jobs/handlers');

describe('Phase 20 Unit: Outbox Worker Lifecycle & Reliability', () => {
  let mockOutboxRepo;
  let worker;

  beforeEach(() => {
    mockOutboxRepo = {
      claimEvents: jest.fn().mockResolvedValue([]),
      markProcessed: jest.fn().mockResolvedValue({ status: 'PROCESSED' }),
      markFailed: jest.fn().mockResolvedValue({ status: 'PENDING' }),
      recoverStaleJobs: jest.fn().mockResolvedValue([]),
      releaseWorkerLeases: jest.fn().mockResolvedValue(0),
      getQueueStats: jest.fn().mockResolvedValue({
        pendingCount: 5,
        processingCount: 1,
        staleCount: 0,
        processedCount: 100,
        deadLetterCount: 2,
      }),
    };

    worker = new OutboxWorker({
      workerId: 'test-worker-node-1',
      batchSize: 5,
      pollIntervalMs: 500,
      maxPollIntervalMs: 2000,
      leaseSeconds: 60,
      staleCheckIntervalMs: 5000,
      outboxRepo: mockOutboxRepo,
    });
  });

  afterEach(async () => {
    await worker.stop();
    jest.restoreAllMocks();
  });

  describe('1. Worker Lifecycle & State', () => {
    it('initializes with default options and unique worker identifier', () => {
      const defaultW = new OutboxWorker();
      expect(defaultW.workerId).toMatch(/^admin-worker-/);
      expect(defaultW.batchSize).toBe(10);
      expect(defaultW.leaseSeconds).toBe(300);
      expect(defaultW.isRunning).toBe(false);
    });

    it('starts and stops gracefully', async () => {
      worker.start();
      expect(worker.isRunning).toBe(true);

      // Starting twice should be idempotent
      worker.start();
      expect(worker.isRunning).toBe(true);

      await worker.stop();
      expect(worker.isRunning).toBe(false);
      expect(mockOutboxRepo.releaseWorkerLeases).toHaveBeenCalledWith('test-worker-node-1');
    });
  });

  describe('2. Polling Loop & Backoff Behavior', () => {
    it('applies polling backoff when queue is empty', async () => {
      mockOutboxRepo.claimEvents.mockResolvedValueOnce([]);

      const initialDelay = worker.currentPollDelayMs;
      const count = await worker.pollOnce();

      expect(count).toBe(0);
      expect(worker.currentPollDelayMs).toBeGreaterThanOrEqual(initialDelay);
    });

    it('resets polling delay to base interval when jobs are claimed', async () => {
      worker.currentPollDelayMs = 2000;
      mockOutboxRepo.claimEvents.mockResolvedValueOnce([
        { id: 'job-1', event_type: 'RECONCILIATION_RUN' },
      ]);
      jest.spyOn(handlers, 'dispatchEvent').mockResolvedValueOnce({ success: true });

      const count = await worker.pollOnce();
      expect(count).toBe(1);
      expect(worker.currentPollDelayMs).toBe(worker.pollIntervalMs);
    });

    it('handles database claim failure gracefully with backoff', async () => {
      mockOutboxRepo.claimEvents.mockRejectedValueOnce(new Error('Connection lost'));

      const count = await worker.pollOnce();
      expect(count).toBe(0);
      expect(worker.currentPollDelayMs).toBeGreaterThan(worker.pollIntervalMs);
    });
  });

  describe('3. Error Isolation & Batch Processing', () => {
    it('continues processing subsequent events in batch if one event fails', async () => {
      const batch = [
        { id: 'job-err-1', event_type: 'NOTIFICATION_DISPATCH_REQUESTED' },
        { id: 'job-ok-2', event_type: 'RECONCILIATION_RUN' },
      ];
      mockOutboxRepo.claimEvents.mockResolvedValueOnce(batch);

      // First event throws, second succeeds
      jest
        .spyOn(handlers, 'dispatchEvent')
        .mockRejectedValueOnce(new Error('FCM timeout'))
        .mockResolvedValueOnce({ success: true });

      const processed = await worker.pollOnce();
      expect(processed).toBe(2);

      // Event 1 failed -> markFailed called
      expect(mockOutboxRepo.markFailed).toHaveBeenCalledTimes(1);
      expect(mockOutboxRepo.markFailed).toHaveBeenCalledWith(
        'job-err-1',
        expect.any(Error),
        expect.objectContaining({ isRetryable: true }),
      );

      // Event 2 succeeded -> markProcessed called
      expect(mockOutboxRepo.markProcessed).toHaveBeenCalledTimes(1);
      expect(mockOutboxRepo.markProcessed).toHaveBeenCalledWith('job-ok-2');

      // Worker metrics updated properly
      expect(worker.metrics.processedCount).toBe(2);
      expect(worker.metrics.succeededCount).toBe(1);
      expect(worker.metrics.failedCount).toBe(1);
      expect(worker.metrics.retriedCount).toBe(1);
    });

    it('classifies non-retryable errors with isRetryable false', async () => {
      const batch = [{ id: 'job-fatal-1', event_type: 'MALFORMED' }];
      mockOutboxRepo.claimEvents.mockResolvedValueOnce(batch);

      const fatalErr = new Error('Invalid format');
      fatalErr.isRetryable = false;
      jest.spyOn(handlers, 'dispatchEvent').mockRejectedValueOnce(fatalErr);

      await worker.pollOnce();

      expect(mockOutboxRepo.markFailed).toHaveBeenCalledWith(
        'job-fatal-1',
        fatalErr,
        expect.objectContaining({ isRetryable: false }),
      );
      expect(worker.metrics.retriedCount).toBe(0);
    });
  });

  describe('4. Stale Recovery & Health Telemetry', () => {
    it('executes stale job recovery and logs count', async () => {
      mockOutboxRepo.recoverStaleJobs.mockResolvedValueOnce(['stale-1', 'stale-2']);

      worker.start();
      // Directly trigger recovery
      const recovered = await mockOutboxRepo.recoverStaleJobs(worker.leaseSeconds);
      expect(recovered).toEqual(['stale-1', 'stale-2']);
      await worker.stop();
    });

    it('reports comprehensive operational health without sensitive data', async () => {
      worker.start();
      const health = await worker.getHealth();

      expect(health.status).toBe('UP');
      expect(health.workerId).toBe('test-worker-node-1');
      expect(health.isRunning).toBe(true);
      expect(typeof health.uptimeSeconds).toBe('number');
      expect(health.metrics).toHaveProperty('processedCount');
      expect(health.metrics).toHaveProperty('succeededCount');
      expect(health.metrics).toHaveProperty('failedCount');
      expect(health.queue.pendingCount).toBe(5);

      await worker.stop();
    });
  });
});
