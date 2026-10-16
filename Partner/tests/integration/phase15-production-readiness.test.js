'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const reconciliationService = require('../../src/services/reconciliation.service');
const { checkDbHealth } = require('../../src/db/pool');

jest.mock('../../src/db/pool', () => {
  const original = jest.requireActual('../../src/db/pool');
  return {
    ...original,
    checkDbHealth: jest.fn(),
  };
});

describe('Integration: Phase 15 Production Readiness, Operational Hardening & Scale Safety', () => {
  let app;
  let mockAuth;

  const adminId = '99999999-9999-4999-a999-999999999999';

  beforeAll(() => {
    app = createApp();
  });

  afterAll(() => {
    PartnerRepository.setMockPartnerResolver(null);
  });

  beforeEach(() => {
    jest.clearAllMocks();

    mockAuth = {
      verifyIdToken: jest.fn(async (token) => {
        if (token === 'admin-token') {
          return { uid: 'uid-admin', phone_number: '+919876543299' };
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
      return null;
    });
  });

  describe('1. Security Headers & Protocol Protection', () => {
    it('sets strict production security headers via Helmet', async () => {
      const res = await request(app).get('/health/live');

      expect(res.status).toBe(200);
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBeDefined();
      expect(res.headers['strict-transport-security']).toBeDefined();
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('attaches unique X-Request-Id header to every response', async () => {
      const res = await request(app).get('/health/live');
      expect(res.headers['x-request-id']).toBeDefined();
      expect(res.headers['x-request-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });
  });

  describe('2. Request Body Limit & Malformed Payload Handling', () => {
    it('rejects malformed JSON payloads with 400 INVALID_JSON', async () => {
      const res = await request(app)
        .post('/api/v1/auth/verify')
        .set('Content-Type', 'application/json')
        .send('{"invalid_json": true,'); // truncated JSON

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_JSON');
      expect(res.body.error.message).toContain('Malformed JSON');
    });

    it('rejects request bodies exceeding 10kb limit with 413 PAYLOAD_TOO_LARGE', async () => {
      const oversizedPayload = { data: 'x'.repeat(12 * 1024) }; // ~12kb

      const res = await request(app)
        .post('/api/v1/auth/verify')
        .set('Content-Type', 'application/json')
        .send(oversizedPayload);

      expect(res.status).toBe(413);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  describe('3. Health, Liveness & Readiness Probes', () => {
    it('GET /health/live returns 200 with UP status', async () => {
      const res = await request(app).get('/health/live');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('UP');
    });

    it('GET /health/ready returns 200 READY when database and redis are healthy', async () => {
      checkDbHealth.mockResolvedValue({ status: 'UP', latencyMs: 2 });

      const res = await request(app).get('/health/ready');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('READY');
    });

    it('GET /health/ready returns 503 NOT_READY when database is down in non-test mode', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      checkDbHealth.mockResolvedValue({ status: 'DOWN', error: 'Connection refused' });

      try {
        const res = await request(app).get('/health/ready');
        expect(res.status).toBe(503);
        expect(res.body.success).toBe(false);
        expect(res.body.data.status).toBe('NOT_READY');
        expect(res.body.data.dependencies.database.status).toBe('DOWN');
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('GET /api/v1/health returns 200 API level health status', async () => {
      const res = await request(app).get('/api/v1/health');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.service).toBe('gongo-partner-backend');
      expect(res.body.data.apiVersion).toBe('v1');
    });
  });

  describe('4. Financial Reconciliation Engine & Admin Audit Endpoint', () => {
    it('GET /api/v1/admin/financials/reconciliation runs platform audit successfully', async () => {
      const spy = jest.spyOn(reconciliationService, 'runPlatformReconciliation').mockResolvedValue({
        isConsistent: true,
        auditedWallets: 5,
        discrepanciesCount: 0,
        discrepancies: [],
        reconciledAt: new Date().toISOString(),
      });

      try {
        const res = await request(app)
          .get('/api/v1/admin/financials/reconciliation')
          .set('Authorization', 'Bearer admin-token');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.isConsistent).toBe(true);
        expect(res.body.data.auditedWallets).toBe(5);
        expect(res.body.data.discrepanciesCount).toBe(0);
      } finally {
        spy.mockRestore();
      }
    });

    it('detects discrepancies in platform reconciliation audit when ledger diverges', async () => {
      const mockAuditDb = {
        query: jest.fn()
          .mockResolvedValueOnce({
            rows: [{
              wallet_id: 'wal-1',
              partner_id: 'partner-1',
              wallet_available: '1000.00',
              wallet_credited: '1000.00',
              wallet_debited: '0.00',
              ledger_credited: '800.00', // discrepancy: 800 vs 1000
              ledger_debited: '0.00',
            }],
          })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] }),
      };

      const result = await reconciliationService.runPlatformReconciliation(mockAuditDb);
      expect(result.isConsistent).toBe(false);
      expect(result.discrepanciesCount).toBeGreaterThan(0);
      expect(result.discrepancies[0].type).toBe('WALLET_AVAILABLE_BALANCE_MISMATCH');
    });
  });

  describe('5. Production Fail-Fast Environment Validation', () => {
    it('fails fast when CASHFREE credentials or ENCRYPTION_KEY missing in production', () => {
      const originalEnv = { ...process.env };
      try {
        process.env.NODE_ENV = 'production';
        process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
        process.env.REDIS_URL = 'redis://localhost:6379';
        process.env.USE_REDIS_MOCK = 'false';
        process.env.SUPABASE_URL = 'https://prod-project.supabase.co';
        process.env.SUPABASE_ANON_KEY = 'real-prod-anon-key';
        process.env.SUPABASE_SERVICE_ROLE_KEY = 'real-prod-service-role-key';
        process.env.SUPABASE_STORAGE_BUCKET = 'prod-bucket';
        delete process.env.ENCRYPTION_KEY;

        jest.resetModules();
        expect(() => {
          // eslint-disable-next-line global-require
          require('../../src/config/env');
        }).toThrow('ENCRYPTION_KEY is strictly required in production');
      } finally {
        process.env = originalEnv;
        jest.resetModules();
        // eslint-disable-next-line global-require
        require('../../src/config/env');
      }
    });
  });
});
