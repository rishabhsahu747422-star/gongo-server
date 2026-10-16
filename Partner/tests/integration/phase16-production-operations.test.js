'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const outboxService = require('../../src/services/outbox.service');
const OutboxRepository = require('../../src/repositories/outbox.repository');
const metrics = require('../../src/utils/metrics');
const { runWithContext, getRequestId } = require('../../src/utils/context');

describe('Integration: Phase 16 Production Operations, Observability & Reliability', () => {
  let app;
  let mockAuth;

  const adminId = '99999999-9999-4999-a999-999999999999';
  const partnerId = '11111111-1111-4111-a111-111111111111';

  beforeAll(() => {
    app = createApp();
  });

  afterAll(() => {
    PartnerRepository.setMockPartnerResolver(null);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    metrics.reset();

    mockAuth = {
      verifyIdToken: jest.fn(async (token) => {
        if (token === 'admin-token') {
          return { uid: 'uid-admin', phone_number: '+919876543299' };
        }
        if (token === 'partner-token') {
          return { uid: 'uid-partner', phone_number: '+919876543210' };
        }
        const err = new Error('Invalid token');
        err.code = 'auth/invalid-id-token';
        throw err;
      }),
      revokeRefreshTokens: jest.fn().mockResolvedValue(true),
    };
    setMockFirebaseAuth(mockAuth);

    PartnerRepository.setMockPartnerResolver((idOrAuth) => {
      if (idOrAuth === 'uid-admin' || idOrAuth === adminId) {
        return {
          id: adminId,
          partnerId: adminId,
          userId: 'user-admin',
          auth_id: 'uid-admin',
          role: 'ADMIN',
          is_active: true,
        };
      }
      if (idOrAuth === 'uid-partner' || idOrAuth === partnerId) {
        return {
          id: partnerId,
          partnerId,
          userId: 'user-partner',
          auth_id: 'uid-partner',
          role: 'PARTNER',
          is_active: true,
        };
      }
      return null;
    });
  });

  // ── 1. Request Tracing & Correlation Logging ─────────────────────
  describe('1. Request Tracing & Correlation Context', () => {
    it('propagates incoming valid X-Request-Id to response header', async () => {
      const customReqId = '12345678-1234-4234-8234-1234567890ab';
      const res = await request(app)
        .get('/health/live')
        .set('X-Request-Id', customReqId);

      expect(res.status).toBe(200);
      expect(res.headers['x-request-id']).toBe(customReqId);
    });

    it('generates a new UUID when X-Request-Id is invalid or absent', async () => {
      const res = await request(app)
        .get('/health/live')
        .set('X-Request-Id', 'not-a-valid-uuid');

      expect(res.status).toBe(200);
      expect(res.headers['x-request-id']).toBeDefined();
      expect(res.headers['x-request-id']).not.toBe('not-a-valid-uuid');
      expect(res.headers['x-request-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('maintains request ID in AsyncLocalStorage execution context', (done) => {
      const expectedId = 'abcdef12-3456-4789-abcd-ef1234567890';
      runWithContext({ requestId: expectedId }, () => {
        expect(getRequestId()).toBe(expectedId);
        done();
      });
    });
  });

  // ── 2. Centralized Error Classification & Shielding ──────────────
  describe('2. Centralized Error Classification & Shielding', () => {
    it('returns standardized error response without leaking internal stack traces', async () => {
      const res = await request(app)
        .get('/api/v1/partner/unknown-endpoint-404')
        .set('Authorization', 'Bearer partner-token');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.error.message).toBeDefined();
      expect(res.body.requestId).toBeDefined();
      expect(res.body.stack).toBeUndefined();
    });

    it('shields database constraint errors from client disclosure', async () => {
      const res = await request(app)
        .post('/api/v1/auth/check-phone')
        .send({ phoneNumber: '123' }); // Invalid phone number format

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).not.toContain('SELECT');
      expect(res.body.error.message).not.toContain('INSERT');
    });
  });

  // ── 3. Transactional Outbox Pattern & Event Dispatch ─────────────
  describe('3. Transactional Outbox Pattern & Reliable Event Dispatch', () => {
    it('creates an outbox event atomically with business parameters', async () => {
      const mockOutboxRepo = new OutboxRepository();
      const mockDbClient = {
        query: jest.fn().mockResolvedValue({
          rows: [{
            id: 'outbox-1',
            event_type: 'PAYOUT_COMPLETED',
            aggregate_type: 'PAYOUT',
            aggregate_id: 'payout-123',
            status: 'PENDING',
            retry_count: 0,
          }],
        }),
      };

      const event = await mockOutboxRepo.createEvent({
        eventType: 'PAYOUT_COMPLETED',
        aggregateType: 'PAYOUT',
        aggregateId: 'payout-123',
        payload: { partnerId: 'partner-1', amount: 500 },
      }, mockDbClient);

      expect(event.id).toBe('outbox-1');
      expect(event.event_type).toBe('PAYOUT_COMPLETED');
      expect(mockDbClient.query).toHaveBeenCalled();
    });

    it('processes batch of pending outbox events and marks completed', async () => {
      const mockEvent = {
        id: 'evt-100',
        event_type: 'PAYOUT_COMPLETED',
        aggregate_type: 'PAYOUT',
        aggregate_id: 'payout-100',
        payload: JSON.stringify({ partnerId: 'p-100', amount: 1500 }),
      };

      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [] }) // BEGIN
          .mockResolvedValueOnce({ rows: [] }) // Notification insert
          .mockResolvedValueOnce({ rows: [{ id: 'evt-100', status: 'COMPLETED' }] }) // UPDATE
          .mockResolvedValueOnce({ rows: [] }), // COMMIT
        release: jest.fn(),
      };

      jest.spyOn(outboxService.pool, 'connect').mockResolvedValue(mockClient);
      jest.spyOn(outboxService.outboxRepository, 'fetchPendingEvents')
        .mockResolvedValue([mockEvent]);
      jest.spyOn(outboxService.outboxRepository, 'markCompleted')
        .mockResolvedValue({ id: 'evt-100', status: 'COMPLETED' });

      const result = await outboxService.processBatch(5);

      expect(result.processed).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(0);
      expect(outboxService.outboxRepository.markCompleted).toHaveBeenCalledWith(
        'evt-100',
        mockClient,
      );
    });

    it('schedules retry with exponential backoff on dispatch failure', async () => {
      const mockEvent = {
        id: 'evt-fail',
        event_type: 'PAYOUT_COMPLETED',
        aggregate_type: 'PAYOUT',
        aggregate_id: 'payout-fail',
        payload: JSON.stringify({ partnerId: 'p-fail', amount: 200 }),
      };

      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn(),
      };

      jest.spyOn(outboxService.pool, 'connect').mockResolvedValue(mockClient);
      jest.spyOn(outboxService.outboxRepository, 'fetchPendingEvents')
        .mockResolvedValue([mockEvent]);
      jest.spyOn(outboxService, 'dispatchHandler')
        .mockRejectedValue(new Error('FCM push notification connection error'));
      jest.spyOn(outboxService.outboxRepository, 'markFailed')
        .mockResolvedValue({ id: 'evt-fail', status: 'FAILED', retry_count: 1 });

      const result = await outboxService.processBatch(5);

      expect(result.processed).toBe(1);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(1);
      expect(outboxService.outboxRepository.markFailed).toHaveBeenCalled();
    });
  });

  // ── 4. Operational Metrics Endpoint ──────────────────────────────
  describe('4. Operational Metrics Endpoint & RBAC Protection', () => {
    it('rejects unauthenticated requests to /admin/metrics with 401', async () => {
      const res = await request(app).get('/api/v1/admin/metrics');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('rejects partner role requests to /admin/metrics with 403', async () => {
      const res = await request(app)
        .get('/api/v1/admin/metrics')
        .set('Authorization', 'Bearer partner-token');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('allows admin to access /admin/metrics and returns structured operational counters', async () => {
      jest.spyOn(outboxService, 'getStats').mockResolvedValue({
        pending: 0,
        processing: 0,
        completed: 5,
        failed: 0,
        deadLetter: 0,
        total: 5,
      });

      metrics.recordSettlementWebhook(true);
      metrics.recordPayoutCreation(true);
      metrics.recordPayoutWebhook(false);
      metrics.recordPayoutReversal();

      // Trigger a request so metrics middleware records an HTTP request
      await request(app).get('/health/live');

      const res = await request(app)
        .get('/api/v1/admin/metrics')
        .set('Authorization', 'Bearer admin-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.http).toBeDefined();
      expect(res.body.data.http.totalRequests).toBeGreaterThanOrEqual(1);
      expect(res.body.data.financial.settlementWebhookSuccess).toBe(1);
      expect(res.body.data.financial.payoutCreationSuccess).toBe(1);
      expect(res.body.data.financial.payoutWebhookFailure).toBe(1);
      expect(res.body.data.financial.payoutReversals).toBe(1);
      expect(res.body.data.infrastructure).toBeDefined();
      expect(res.body.data.outbox).toBeDefined();
    });
  });

  // ── 5. Graceful Lifecycle & Process Safety ───────────────────────
  describe('5. Graceful Lifecycle & Outbox Worker Control', () => {
    it('starts and stops outbox worker cleanly without unhandled rejections', async () => {
      outboxService.startWorker(50000);
      expect(outboxService.pollInterval).toBeDefined();

      await outboxService.stopWorker();
      expect(outboxService.pollInterval).toBeNull();
      expect(outboxService.isShuttingDown).toBe(true);
    });
  });
});
