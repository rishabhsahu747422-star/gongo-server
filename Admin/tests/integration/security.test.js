'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { installTokenSessions } = require('../support/token-sessions');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Integration: Security Foundation & Authorization Regression Suite', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  let uninstallSessions;

  // Tokens are server-side admin sessions (the only credential the Admin API accepts).
  beforeEach(() => {
    const admin = (id, permissions, extra = {}) => ({
      id, role: 'ADMIN', permissions, is_active: true, ...extra,
    });
    uninstallSessions = installTokenSessions({
      'valid-admin-token': { user: admin('admin-123', ['OPERATIONS_ADMIN']) },
      'super-admin-token': { user: admin('admin-super', ['SUPER_ADMIN']) },
      'ops-admin-token': { user: admin('admin-ops', ['OPERATIONS_ADMIN']) },
      'valid-customer-token': { user: { id: 'customer-123', role: 'CUSTOMER', is_active: true } },
      'valid-partner-token': { user: { id: 'partner-123', role: 'PARTNER', is_active: true } },
      'deactivated-admin-token': { user: admin('admin-deactivated', [], { is_active: false }) },
      'expired-token': { user: admin('admin-123', ['OPERATIONS_ADMIN']), expired: true },
      'revoked-token': { user: admin('admin-123', ['OPERATIONS_ADMIN']), revoked: true },
    });
  });

  afterEach(() => {
    uninstallSessions();
    jest.restoreAllMocks();
  });

  // ── 1. Security Headers ──────────────────────────────────────────
  describe('1. Security Headers & Hardening', () => {
    it('sets strict security headers on responses', async () => {
      const res = await request(app).get('/health/live');

      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toContain('no-store');
    });
  });

  // ── 2. CORS Security ─────────────────────────────────────────────
  describe('2. CORS Protection', () => {
    it('allows registered origin with Access-Control-Allow-Origin header', async () => {
      const res = await request(app)
        .get('/health/live')
        .set('Origin', 'http://localhost:3000');

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    });

    it('rejects unauthorized origin with 403 Forbidden', async () => {
      const res = await request(app)
        .get('/health/live')
        .set('Origin', 'https://malicious-attacker.com');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });
  });

  // ── 3. Payload Size Limitation ───────────────────────────────────
  describe('3. Payload Size Limitation (10kb limit)', () => {
    it('accepts valid small JSON payloads', async () => {
      const res = await request(app)
        .post('/api/v1/test/audit')
        .set('Authorization', 'Bearer valid-admin-token')
        .send({ action: 'TEST', targetResource: 'RESOURCE' });

      expect(res.status).toBe(200);
    });

    it('rejects oversized JSON payloads (>10kb) with 413 Payload Too Large', async () => {
      const largePayload = {
        data: 'x'.repeat(12 * 1024), // 12kb
      };

      const res = await request(app)
        .post('/api/v1/test/audit')
        .set('Authorization', 'Bearer valid-admin-token')
        .send(largePayload);

      expect(res.status).toBe(413);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.PAYLOAD_TOO_LARGE);
    });
  });

  // ── 4. Authentication Security & Zero Backdoors ─────────────────
  describe('4. Authentication Security & Zero Backdoors', () => {
    it('rejects request with missing Authorization header with 401', async () => {
      const res = await request(app).get('/api/v1/admin');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTH_REQUIRED);
    });

    it('rejects malformed Authorization header with 401', async () => {
      const res = await request(app)
        .get('/api/v1/admin')
        .set('Authorization', 'Basic 123456');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(ERROR_CODES.INVALID_TOKEN);
    });

    it('rejects expired token with 401 TOKEN_EXPIRED', async () => {
      const res = await request(app)
        .get('/api/v1/admin')
        .set('Authorization', 'Bearer expired-token');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(ERROR_CODES.TOKEN_EXPIRED);
    });

    it('rejects revoked token with 401 TOKEN_REVOKED', async () => {
      const res = await request(app)
        .get('/api/v1/admin')
        .set('Authorization', 'Bearer revoked-token');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(ERROR_CODES.TOKEN_REVOKED);
    });

    it('rejects forged / dev-token backdoor attempts with 401 INVALID_TOKEN', async () => {
      const res = await request(app)
        .get('/api/v1/admin')
        .set('Authorization', 'Bearer dev-token-admin')
        .set('x-admin', 'true');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(ERROR_CODES.INVALID_TOKEN);
    });
  });

  // ── 5. Role Authorization & Cross-Boundary Isolation ─────────────
  describe('5. Role Authorization & Cross-Boundary Isolation', () => {
    it('rejects CUSTOMER role from accessing admin endpoints with 403', async () => {
      const res = await request(app)
        .get('/api/v1/admin')
        .set('Authorization', 'Bearer valid-customer-token');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });

    it('rejects PARTNER role from accessing admin endpoints with 403', async () => {
      const res = await request(app)
        .get('/api/v1/admin')
        .set('Authorization', 'Bearer valid-partner-token');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });

    it('allows authenticated user with ADMIN role to access admin gateway', async () => {
      const res = await request(app)
        .get('/api/v1/admin')
        .set('Authorization', 'Bearer valid-admin-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.actor.role).toBe('ADMIN');
    });

    it('rejects deactivated ADMIN user with 403 ACCOUNT_DEACTIVATED', async () => {
      const res = await request(app)
        .get('/api/v1/admin')
        .set('Authorization', 'Bearer deactivated-admin-token');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(ERROR_CODES.ACCOUNT_DEACTIVATED);
    });
  });

  // ── 6. Permission Group Authorization ────────────────────────────
  describe('6. Permission Group Authorization', () => {
    it('rejects ADMIN lacking required permission with 403 INSUFFICIENT_PERMISSIONS', async () => {
      // route requires SUPER_ADMIN or FINANCE_ADMIN; ops user has OPERATIONS_ADMIN
      const res = await request(app)
        .get('/api/v1/test/permission')
        .set('Authorization', 'Bearer ops-admin-token');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(ERROR_CODES.INSUFFICIENT_PERMISSIONS);
    });

    it('allows ADMIN possessing SUPER_ADMIN permission to pass permission check', async () => {
      const res = await request(app)
        .get('/api/v1/test/permission')
        .set('Authorization', 'Bearer super-admin-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
