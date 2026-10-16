'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Phase 1 — Security Foundation Regression Suite', () => {
  let app;
  let mockAuth;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    // Setup mock Firebase auth provider
    mockAuth = {
      verifyIdToken: jest.fn(async (token) => {
        if (token === 'valid-partner-token') {
          return { uid: 'uid-partner-1', email: 'partner1@gongo.in', phone_number: '+919876543210' };
        }
        if (token === 'valid-partner-2-token') {
          return { uid: 'uid-partner-2', email: 'partner2@gongo.in', phone_number: '+919876543211' };
        }
        if (token === 'valid-customer-token') {
          return { uid: 'uid-customer-1', email: 'customer1@gongo.in' };
        }
        if (token === 'deactivated-partner-token') {
          return { uid: 'uid-partner-deactivated' };
        }
        if (token === 'expired-token') {
          const err = new Error('Token expired');
          err.code = 'auth/id-token-expired';
          throw err;
        }
        if (token === 'revoked-token') {
          const err = new Error('Token revoked');
          err.code = 'auth/id-token-revoked';
          throw err;
        }
        const err = new Error('Invalid token');
        err.code = 'auth/invalid-id-token';
        throw err;
      }),
    };
    setMockFirebaseAuth(mockAuth);

    // Setup mock partner repository resolver
    PartnerRepository.setMockPartnerResolver((authId) => {
      if (authId === 'uid-partner-1') {
        return {
          id: 'partner-123',
          auth_id: 'uid-partner-1',
          role: 'PARTNER',
          is_active: true,
          status: 'ACTIVE',
        };
      }
      if (authId === 'uid-partner-2') {
        return {
          id: 'partner-456',
          auth_id: 'uid-partner-2',
          role: 'PARTNER',
          is_active: true,
          status: 'ACTIVE',
        };
      }
      if (authId === 'uid-customer-1') {
        return {
          id: 'customer-999',
          auth_id: 'uid-customer-1',
          role: 'CUSTOMER',
          is_active: true,
          status: 'ACTIVE',
        };
      }
      if (authId === 'uid-partner-deactivated') {
        return {
          id: 'partner-deactivated',
          auth_id: 'uid-partner-deactivated',
          role: 'PARTNER',
          is_active: false,
          status: 'SUSPENDED',
        };
      }
      return null;
    });
  });

  // ── 1. Authentication Security ──────────────────────────────────
  describe('1. Authentication Security', () => {
    it('rejects request with missing Authorization header', async () => {
      const res = await request(app).get('/api/v1/test/auth');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTH_REQUIRED);
      expect(res.body.requestId).toBeDefined();
    });

    it('rejects request with malformed Authorization header (no Bearer prefix)', async () => {
      const res = await request(app)
        .get('/api/v1/test/auth')
        .set('Authorization', 'Basic dXNlcjpwYXNz');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.INVALID_TOKEN);
    });

    it('rejects request with empty Bearer token', async () => {
      const res = await request(app)
        .get('/api/v1/test/auth')
        .set('Authorization', 'Bearer ');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.INVALID_TOKEN);
    });

    it('rejects expired Firebase token with TOKEN_EXPIRED code', async () => {
      const res = await request(app)
        .get('/api/v1/test/auth')
        .set('Authorization', 'Bearer expired-token');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.TOKEN_EXPIRED);
    });

    it('rejects revoked Firebase token with TOKEN_REVOKED code', async () => {
      const res = await request(app)
        .get('/api/v1/test/auth')
        .set('Authorization', 'Bearer revoked-token');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.TOKEN_REVOKED);
    });

    it('rejects invalid Firebase token with INVALID_TOKEN code without leaking internals', async () => {
      const res = await request(app)
        .get('/api/v1/test/auth')
        .set('Authorization', 'Bearer invalid-token');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.INVALID_TOKEN);
      expect(res.body.error.message).not.toContain('auth/invalid-id-token');
    });

    it('rejects deactivated partner account', async () => {
      const res = await request(app)
        .get('/api/v1/test/auth')
        .set('Authorization', 'Bearer deactivated-partner-token');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.ACCOUNT_DEACTIVATED);
    });

    it('successfully authenticates valid partner and attaches trusted backend identity', async () => {
      const res = await request(app)
        .get('/api/v1/test/auth')
        .set('Authorization', 'Bearer valid-partner-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.id).toBe('partner-123');
      expect(res.body.data.user.partnerId).toBe('partner-123');
      expect(res.body.data.user.role).toBe('PARTNER');
    });
  });

  // ── 2. Role Authorization & Spoofing Prevention ─────────────────
  describe('2. Role Authorization & Anti-Spoofing', () => {
    it('allows access to PARTNER role', async () => {
      const res = await request(app)
        .get('/api/v1/test/partner-only')
        .set('Authorization', 'Bearer valid-partner-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('denies access to CUSTOMER role on partner-only route', async () => {
      const res = await request(app)
        .get('/api/v1/test/partner-only')
        .set('Authorization', 'Bearer valid-customer-token');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });

    it('prevents client-supplied role in query or body from overriding backend identity', async () => {
      const res = await request(app)
        .get('/api/v1/test/partner-only?role=PARTNER')
        .send({ role: 'PARTNER' })
        .set('Authorization', 'Bearer valid-customer-token');

      // Even though client sent role=PARTNER, trusted backend role is CUSTOMER -> must be 403
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });
  });

  // ── 3. BOLA / IDOR Resource Ownership Protection ─────────────────
  describe('3. Resource Ownership & BOLA Prevention', () => {
    it('allows access when resource belongs to the authenticated partner', async () => {
      const res = await request(app)
        .get('/api/v1/test/resource/resource-partner-1')
        .set('Authorization', 'Bearer valid-partner-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.resource.id).toBe('resource-partner-1');
    });

    it('denies access (403) when Partner A attempts to access Partner B resource', async () => {
      const res = await request(app)
        .get('/api/v1/test/resource/resource-partner-2')
        .set('Authorization', 'Bearer valid-partner-token');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });

    it('prevents client-supplied partnerId query from bypassing ownership', async () => {
      const res = await request(app)
        .get('/api/v1/test/resource/resource-partner-2?partnerId=partner-other')
        .set('Authorization', 'Bearer valid-partner-token');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });

    it('returns 404 for non-existent resource', async () => {
      const res = await request(app)
        .get('/api/v1/test/resource/non-existent-resource')
        .set('Authorization', 'Bearer valid-partner-token');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.NOT_FOUND);
    });
  });

  // ── 4. Mass Assignment Protection ────────────────────────────────
  describe('4. Mass Assignment Protection', () => {
    it('rejects requests containing server-controlled financial fields (walletBalance)', async () => {
      const res = await request(app)
        .post('/api/v1/test/mass-assignment')
        .send({ name: 'Valid Payload', walletBalance: 999999 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
      expect(res.body.error.message).toContain('walletBalance');
    });

    it('rejects requests attempting to inject commission data', async () => {
      const res = await request(app)
        .post('/api/v1/test/mass-assignment')
        .send({ name: 'Listing', commissionRate: 0.05, commissionAmount: 50 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
    });

    it('rejects requests attempting to inject partnerId or role', async () => {
      const res = await request(app)
        .post('/api/v1/test/mass-assignment')
        .send({ partnerId: 'injected-id', role: 'ADMIN' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
    });

    it('rejects requests attempting to set verificationStatus or payoutStatus', async () => {
      const res = await request(app)
        .post('/api/v1/test/mass-assignment')
        .send({ verificationStatus: 'VERIFIED', payoutStatus: 'PAID' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
    });

    it('allows valid business fields that are not server-controlled', async () => {
      const res = await request(app)
        .post('/api/v1/test/mass-assignment')
        .send({ vehicleName: 'Honda Activa 6G', registrationYear: 2023 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.received.vehicleName).toBe('Honda Activa 6G');
    });
  });

  // ── 5. Security Headers (Helmet) & Information Disclosure ────────
  describe('5. Security Headers & Information Disclosure', () => {
    it('sets strict Helmet headers on responses', async () => {
      const res = await request(app).get('/health/live');

      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['strict-transport-security']).toBeDefined();
      expect(res.headers['content-security-policy']).toBeDefined();
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    });

    it('does not expose X-Powered-By header', async () => {
      const res = await request(app).get('/health/live');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });

  // ── 6. CORS Origin Security ──────────────────────────────────────
  describe('6. CORS Origin Security', () => {
    it('permits requests from configured allowed origin', async () => {
      const res = await request(app)
        .get('/health/live')
        .set('Origin', 'http://localhost:3000');

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    });

    it('rejects requests from unauthorized origin with 403 Forbidden', async () => {
      const res = await request(app)
        .get('/health/live')
        .set('Origin', 'https://malicious-site.com');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });
  });

  // ── 7. Request ID Validation & Propagation ───────────────────────
  describe('7. Request ID Validation', () => {
    it('generates a secure UUID when X-Request-Id header is absent', async () => {
      const res = await request(app).get('/health/live');

      expect(res.headers['x-request-id']).toBeDefined();
      expect(res.headers['x-request-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('preserves valid incoming UUID X-Request-Id header', async () => {
      const customId = 'e3b0c442-98fc-1c14-9afb-4c7b88495574';
      const res = await request(app)
        .get('/health/live')
        .set('X-Request-Id', customId);

      expect(res.headers['x-request-id']).toBe(customId);
    });

    it('replaces malicious/oversized X-Request-Id with a secure UUID', async () => {
      const maliciousId = `<script>alert(1)</script>${'A'.repeat(500)}`;
      const res = await request(app)
        .get('/health/live')
        .set('X-Request-Id', maliciousId);

      expect(res.headers['x-request-id']).not.toBe(maliciousId);
      expect(res.headers['x-request-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('includes requestId in error responses', async () => {
      const res = await request(app).get('/api/v1/non-existent-route');

      expect(res.status).toBe(404);
      expect(res.body.requestId).toBeDefined();
      expect(res.body.requestId).toBe(res.headers['x-request-id']);
    });
  });

  // ── 8. Payload Limits & Malformed Input Handling ─────────────────
  describe('8. Payload Limits & Malformed Input', () => {
    it('rejects payloads larger than 10kb with 413 Payload Too Large', async () => {
      const largeData = 'x'.repeat(15 * 1024); // 15kb string
      const res = await request(app)
        .post('/api/v1/test/mass-assignment')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ data: largeData }));

      expect(res.status).toBe(413);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.PAYLOAD_TOO_LARGE);
    });

    it('safely handles malformed JSON without crashing or leaking internals', async () => {
      const res = await request(app)
        .post('/api/v1/test/mass-assignment')
        .set('Content-Type', 'application/json')
        .send('{ invalid json');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.INVALID_JSON);
      expect(res.body.error.message).not.toContain('SyntaxError');
    });
  });

  // ── 9. Error Sanitization ────────────────────────────────────────
  describe('9. Error Sanitization', () => {
    it('never leaks stack traces, SQL, or internal paths in error responses', async () => {
      const res = await request(app).get('/api/v1/test/error-leak-probe');

      expect(res.body.error).toBeDefined();
      expect(res.body.stack).toBeUndefined();
      expect(res.body._debug).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('C:\\');
      expect(JSON.stringify(res.body)).not.toContain('node_modules');
      expect(JSON.stringify(res.body)).not.toContain('password');
    });
  });

  // ── 10. Rate Limiting ────────────────────────────────────────────
  describe('10. Rate Limiting Foundation', () => {
    it('attaches rate limit headers and enforces rate limiting after exceeding max requests', async () => {
      // Endpoint is configured with max: 3 requests
      const res1 = await request(app).get('/api/v1/test/rate-limited');
      expect(res1.status).toBe(200);
      expect(res1.headers['x-ratelimit-limit']).toBeDefined();

      const res2 = await request(app).get('/api/v1/test/rate-limited');
      expect(res2.status).toBe(200);

      const res3 = await request(app).get('/api/v1/test/rate-limited');
      expect(res3.status).toBe(200);

      // 4th request exceeds max: 3
      const res4 = await request(app).get('/api/v1/test/rate-limited');
      expect(res4.status).toBe(429);
      expect(res4.body.success).toBe(false);
      expect(res4.body.error.code).toBe(ERROR_CODES.RATE_LIMIT_EXCEEDED);
      expect(res4.headers['retry-after']).toBeDefined();
    });
  });

  // ── 11. Idempotency Foundation ───────────────────────────────────
  describe('11. Idempotency Foundation', () => {
    it('requires idempotency key when configured as mandatory', async () => {
      const res = await request(app)
        .post('/api/v1/test/idempotent')
        .set('Authorization', 'Bearer valid-partner-token')
        .send({ action: 'transfer' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_MISSING);
    });

    it('returns original cached response on duplicate idempotent key (replay)', async () => {
      const idempotencyKey = 'unique-operation-key-1';

      const res1 = await request(app)
        .post('/api/v1/test/idempotent')
        .set('Authorization', 'Bearer valid-partner-token')
        .set('Idempotency-Key', idempotencyKey)
        .send({ amount: 500 });

      expect(res1.status).toBe(200);
      const executionTime = res1.body.data.executedAt;

      // Repeat with same key
      const res2 = await request(app)
        .post('/api/v1/test/idempotent')
        .set('Authorization', 'Bearer valid-partner-token')
        .set('Idempotency-Key', idempotencyKey)
        .send({ amount: 500 });

      expect(res2.status).toBe(200);
      expect(res2.headers['x-idempotency-replay']).toBe('true');
      expect(res2.body.data.executedAt).toBe(executionTime);
    });

    it('isolates idempotency keys by authenticated actor (prevents cross-partner collision)', async () => {
      const sharedKey = 'shared-key-123';

      // Partner 1 executes with sharedKey
      const res1 = await request(app)
        .post('/api/v1/test/idempotent')
        .set('Authorization', 'Bearer valid-partner-token')
        .set('Idempotency-Key', sharedKey)
        .send({ actor: 'partner-1' });

      expect(res1.status).toBe(200);

      // Partner 2 executes with identical key -> should NOT collide with Partner 1
      const res2 = await request(app)
        .post('/api/v1/test/idempotent')
        .set('Authorization', 'Bearer valid-partner-2-token')
        .set('Idempotency-Key', sharedKey)
        .send({ actor: 'partner-2' });

      expect(res2.status).toBe(200);
      expect(res2.headers['x-idempotency-replay']).toBeUndefined();
      expect(res2.body.data.echo.actor).toBe('partner-2');
    });
  });
});
