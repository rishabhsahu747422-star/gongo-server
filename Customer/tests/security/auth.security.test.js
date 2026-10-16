'use strict';

const request = require('supertest');
const { newDb, DataType } = require('pg-mem');
const crypto = require('crypto');
const express = require('express');
const { pool } = require('../../src/config/database');
const { setMockFirebaseAuth } = require('../../src/config/firebase');
const redisService = require('../../src/services/redis.service');
const otpService = require('../../src/services/otp.service');
const { createApp } = require('../../src/app');
const { requireRole } = require('../../src/middleware/role.middleware');
const authenticate = require('../../src/middleware/auth.middleware');
const { errorHandler } = require('../../src/middleware/errorHandler');
const migration = require('../../database/migrations/1726300000000_create-users-table');

describe('Step 3 Authentication Security Regression Tests', () => {
  let app;
  let db;
  let mockPool;
  let mockFirebaseAuth;

  beforeAll(async () => {
    // 1. Initialize in-memory PostgreSQL
    db = newDb();
    db.registerExtension('pgcrypto', (schema) => {
      schema.registerFunction({
        name: 'gen_random_uuid',
        returns: DataType.uuid,
        impure: true,
        implementation: () => crypto.randomUUID(),
      });
    });

    const pgm = {
      sql: (statement) => {
        if (!statement.includes('LANGUAGE plpgsql') && !statement.includes('CREATE TRIGGER')) {
          db.public.none(statement);
        }
      },
    };
    await migration.up(pgm);

    const adapter = db.adapters.createPg();
    mockPool = new adapter.Pool();

    pool.query = mockPool.query.bind(mockPool);
    pool.connect = mockPool.connect.bind(mockPool);

    // 2. Configure mock Firebase Auth with token simulation
    mockFirebaseAuth = {
      createCustomToken: jest.fn().mockImplementation(async (uid, claims = {}) => (
        `mock-custom-token-for-${uid}-${claims.role || 'customer'}`
      )),
      verifyIdToken: jest.fn().mockImplementation(async (token) => {
        if (token === 'expired-token') {
          const err = new Error('Token expired');
          err.code = 'auth/id-token-expired';
          throw err;
        }
        if (token === 'refresh-token-opaque' || token === 'invalid-token') {
          const err = new Error('Invalid token');
          err.code = 'auth/argument-error';
          throw err;
        }
        if (token === 'token-user-a-spoofing-b') {
          return {
            uid: 'firebase-uid-user-a',
            gongoUserId: '00000000-0000-0000-0000-000000000002', // User B's id
            auth_time: Math.floor(Date.now() / 1000),
            role: 'customer',
          };
        }
        if (token === 'token-user-b-with-user-a-phone') {
          return {
            uid: 'firebase-uid-user-b',
            phone_number: '+919999999991', // User A's phone number!
            auth_time: Math.floor(Date.now() / 1000),
            role: 'customer',
          };
        }
        if (token === 'token-user-a') {
          return {
            uid: 'firebase-uid-user-a',
            auth_time: Math.floor(Date.now() / 1000),
            phone_number: '+919999999991',
            role: 'customer',
          };
        }
        return {
          uid: 'firebase-uid-test',
          auth_time: Math.floor(Date.now() / 1000),
          phone_number: '+919876543210',
          role: 'customer',
        };
      }),
      revokeRefreshTokens: jest.fn().mockResolvedValue(undefined),
    };
    setMockFirebaseAuth(mockFirebaseAuth);

    // Pre-populate standard test customer in DB
    db.public.none(`
      INSERT INTO users (id, phone, country_code, role, auth_provider, auth_id, is_active)
      VALUES 
        ('00000000-0000-0000-0000-000000000001', '9876543210', '+91', 'customer', 'firebase', 'firebase-uid-test', true),
        ('00000000-0000-0000-0000-000000000002', '9999999992', '+91', 'customer', 'firebase', 'firebase-uid-user-b', true),
        ('00000000-0000-0000-0000-000000000003', '9999999991', '+91', 'customer', 'firebase', 'firebase-uid-user-a', true);
    `);

    app = createApp();
  });

  afterEach(async () => {
    if (redisService.client && typeof redisService.client.flushall === 'function') {
      await redisService.client.flushall();
    }
  });

  // ===========================================================================
  // TEST 1: 20 CONCURRENT WRONG OTP REQUESTS
  // ===========================================================================
  describe('Test 1: 20 concurrent wrong OTP requests', () => {
    it('maximum attempt limit cannot be bypassed by concurrent burst', async () => {
      const vId = otpService.generateVerificationId();
      await redisService.setOtpState(vId, {
        countryCode: '+91',
        phone: '9876500001',
        hashedOtp: otpService.hashOtp('123456'),
        createdAt: Date.now(),
      }, 300);

      // Fire 20 parallel wrong OTP verification requests simultaneously
      const burstRequests = Array.from({ length: 20 }).map(() => (
        request(app)
          .post('/api/v1/auth/verify-otp')
          .send({ verificationId: vId, otp: '999999' })
      ));

      const responses = await Promise.all(burstRequests);

      // Every single request must be rejected (400 Bad Request)
      responses.forEach((res) => {
        expect(res.status).toBe(400);
        expect(['AUTH_INVALID_OTP', 'AUTH_OTP_ATTEMPTS_EXCEEDED', 'AUTH_OTP_EXPIRED']).toContain(res.body.code);
      });

      // The attempt counter must reflect at least the maximum attempts
      const count = await redisService.getOtpAttemptCount(vId);
      expect(count).toBeGreaterThanOrEqual(5);

      // A subsequent correct OTP request MUST fail because session is invalidated
      const retryRes = await request(app)
        .post('/api/v1/auth/verify-otp')
        .send({ verificationId: vId, otp: '123456' });

      expect(retryRes.status).toBe(400);
      expect(['AUTH_OTP_ATTEMPTS_EXCEEDED', 'AUTH_OTP_EXPIRED']).toContain(retryRes.body.code);
    });
  });

  // ===========================================================================
  // TEST 2: MULTIPLE CONCURRENT CORRECT OTP REQUESTS
  // ===========================================================================
  describe('Test 2: Multiple concurrent correct OTP requests', () => {
    it('exactly ONE concurrent request succeeds; all others fail', async () => {
      const vId = otpService.generateVerificationId();
      const validOtp = '654321';
      await redisService.setOtpState(vId, {
        countryCode: '+91',
        phone: '9876500002',
        hashedOtp: otpService.hashOtp(validOtp),
        createdAt: Date.now(),
      }, 300);

      // Fire 10 parallel identical correct requests simultaneously
      const burstRequests = Array.from({ length: 10 }).map(() => (
        request(app)
          .post('/api/v1/auth/verify-otp')
          .send({ verificationId: vId, otp: validOtp })
      ));

      const responses = await Promise.all(burstRequests);

      const successful = responses.filter((r) => r.status === 200);
      const failed = responses.filter((r) => r.status === 400);

      // Atomic single-use consumption guarantee: EXACTLY ONE SUCCESS
      expect(successful).toHaveLength(1);
      expect(failed).toHaveLength(9);

      // Winner receives credentials
      expect(successful[0].body.data.customToken).toBeDefined();

      // Losers are rejected with session expired/consumed error
      failed.forEach((res) => {
        expect(res.body.code).toBe('AUTH_OTP_EXPIRED');
      });
    });
  });

  // ===========================================================================
  // TEST 3: REUSING CONSUMED OTP
  // ===========================================================================
  describe('Test 3: Reusing consumed OTP', () => {
    it('fails on subsequent attempt after successful verification', async () => {
      const vId = otpService.generateVerificationId();
      const validOtp = '112233';
      await redisService.setOtpState(vId, {
        countryCode: '+91',
        phone: '9876500003',
        hashedOtp: otpService.hashOtp(validOtp),
        createdAt: Date.now(),
      }, 300);

      // First call succeeds
      const res1 = await request(app)
        .post('/api/v1/auth/verify-otp')
        .send({ verificationId: vId, otp: validOtp });
      expect(res1.status).toBe(200);

      // Replay attack with same verification ID and OTP code fails
      const res2 = await request(app)
        .post('/api/v1/auth/verify-otp')
        .send({ verificationId: vId, otp: validOtp });
      expect(res2.status).toBe(400);
      expect(res2.body.code).toBe('AUTH_OTP_EXPIRED');
    });
  });

  // ===========================================================================
  // TEST 4: EXPIRED OTP
  // ===========================================================================
  describe('Test 4: Expired OTP', () => {
    it('fails when verification session does not exist or has expired in Redis', async () => {
      const expiredVId = crypto.randomUUID();

      const res = await request(app)
        .post('/api/v1/auth/verify-otp')
        .send({ verificationId: expiredVId, otp: '123456' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('AUTH_OTP_EXPIRED');
    });
  });

  // ===========================================================================
  // TEST 5: FIREBASE EXPIRED ID TOKEN
  // ===========================================================================
  describe('Test 5: Firebase expired ID token', () => {
    it('rejected on protected endpoint /auth/me', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer expired-token');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_EXPIRED_CREDENTIAL');
    });

    it('rejected on /auth/refresh', async () => {
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ token: 'expired-token' });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_EXPIRED_CREDENTIAL');
    });
  });

  // ===========================================================================
  // TEST 6: FIREBASE REFRESH TOKEN SUPPLIED AS ID TOKEN
  // ===========================================================================
  describe('Test 6: Firebase refresh token supplied as ID token', () => {
    it('rejected on protected endpoint /auth/me', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer refresh-token-opaque');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_INVALID_CREDENTIAL');
    });

    it('rejected on /auth/refresh', async () => {
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ token: 'refresh-token-opaque' });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_INVALID_CREDENTIAL');
    });
  });

  // ===========================================================================
  // TEST 7: /auth/me WITH VALID CURRENT FIREBASE ID TOKEN
  // ===========================================================================
  describe('Test 7: /auth/me with valid current Firebase ID token', () => {
    it('succeeds and returns authenticated profile', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer valid-firebase-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.phone).toBe('9876543210');
      expect(res.body.data.role).toBe('customer');
    });
  });

  // ===========================================================================
  // TEST 8: FIREBASE UID BELONGING TO USER A CAN NEVER RESOLVE TO USER B
  // ===========================================================================
  describe('Test 8: Firebase UID of User A cannot resolve to User B', () => {
    it('rejects tampered token attempting cross-user impersonation via gongoUserId', async () => {
      // Token has uid for User A, but maliciously includes gongoUserId for User B
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer token-user-a-spoofing-b');

      // Middleware verifies user.authId === decodedToken.uid; rejects spoofed claim
      expect(res.status).toBe(200);
      // Resolved user MUST be User A (owner of uid 'firebase-uid-user-a'), never User B
      expect(res.body.data.phone).toBe('9999999991'); // User A's phone
      expect(res.body.data.id).toBe('00000000-0000-0000-0000-000000000003'); // User A's id
    });
  });

  // ===========================================================================
  // TEST 9: FIREBASE UID WITH PHONE MATCHING ANOTHER ACCOUNT
  // ===========================================================================
  describe('Test 9: Firebase UID with phone matching another account', () => {
    it('does not impersonate another account via phone fallback', async () => {
      // User B has Firebase UID 'firebase-uid-user-b' and phone '+919999999991'
      // (which belongs to User A in DB).
      // Because phone-based fallback has been REMOVED from auth middleware,
      // it MUST resolve strictly via auth_id ('firebase-uid-user-b') -> User B's record.
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer token-user-b-with-user-a-phone');

      expect(res.status).toBe(200);
      // Must resolve to User B (matching authId 'firebase-uid-user-b'), NOT User A
      expect(res.body.data.id).toBe('00000000-0000-0000-0000-000000000002');
      expect(res.body.data.phone).toBe('9999999992');
    });
  });

  // ===========================================================================
  // TEST 10: CUSTOMER CANNOT BECOME PARTNER / ADMIN
  // ===========================================================================
  describe('Test 10: Customer cannot become partner/admin', () => {
    it('forces role=customer during OTP verification even if client injects role=admin', async () => {
      const vId = otpService.generateVerificationId();
      await redisService.setOtpState(vId, {
        countryCode: '+91',
        phone: '9876500010',
        hashedOtp: otpService.hashOtp('445566'),
        createdAt: Date.now(),
      }, 300);

      const res = await request(app)
        .post('/api/v1/auth/verify-otp')
        .send({
          verificationId: vId,
          otp: '445566',
          role: 'admin', // Malicious attempt to escalate role
        });

      expect(res.status).toBe(200);
      expect(res.body.data.user.role).toBe('customer');

      // Verify DB role is customer
      const rows = db.public.many("SELECT role FROM users WHERE phone = '9876500010'");
      expect(rows[0].role).toBe('customer');
    });

    it('blocks customer from accessing admin-only endpoint via requireRole', async () => {
      const testApp = express();
      testApp.get('/test/admin', authenticate, requireRole('admin'), (req, res) => res.json({ secret: true }));
      testApp.use(errorHandler);

      const res = await request(testApp)
        .get('/test/admin')
        .set('Authorization', 'Bearer valid-firebase-token');

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('allows customer access case-insensitively whether role is CUSTOMER or customer', async () => {
      const testApp = express();
      testApp.get('/test/customer-upper', (req, res, next) => {
        req.user = { id: 'test-user-id', role: 'CUSTOMER' };
        next();
      }, requireRole('customer'), (req, res) => res.json({ success: true }));

      testApp.get('/test/customer-lower', (req, res, next) => {
        req.user = { id: 'test-user-id', role: 'customer' };
        next();
      }, requireRole('customer'), (req, res) => res.json({ success: true }));

      testApp.use(errorHandler);

      const upperRes = await request(testApp).get('/test/customer-upper');
      expect(upperRes.status).toBe(200);
      expect(upperRes.body.success).toBe(true);

      const lowerRes = await request(testApp).get('/test/customer-lower');
      expect(lowerRes.status).toBe(200);
      expect(lowerRes.body.success).toBe(true);
    });
  });

  // ===========================================================================
  // TEST 11: REDIS FAILURE DOES NOT BYPASS OTP BRUTE-FORCE PROTECTION
  // ===========================================================================
  describe('Test 11: Redis failure does not bypass OTP brute-force protection', () => {
    it('fails closed with 503 when Redis fails during attempt counter increment', async () => {
      const vId = otpService.generateVerificationId();
      await redisService.setOtpState(vId, {
        countryCode: '+91',
        phone: '9876500011',
        hashedOtp: otpService.hashOtp('123456'),
        createdAt: Date.now(),
      }, 300);

      // Simulate Redis crash during counter INCR
      const originalIncr = redisService.client.incr.bind(redisService.client);
      redisService.client.incr = jest.fn().mockRejectedValue(new Error('Connection lost'));

      try {
        const res = await request(app)
          .post('/api/v1/auth/verify-otp')
          .send({ verificationId: vId, otp: '000000' });

        // Must fail closed with 503 Service Unavailable, NEVER 200 or silent pass
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('REDIS_UNAVAILABLE');
      } finally {
        redisService.client.incr = originalIncr;
      }
    });
  });

  // ===========================================================================
  // TEST 12: REDIS FAILURE DOES NOT SILENTLY BYPASS SESSION REVOCATION
  // ===========================================================================
  describe('Test 12: Redis failure does not silently bypass session revocation', () => {
    it('fails closed with 503 when Redis is unavailable during revocation check', async () => {
      // Simulate Redis crash during get
      const originalGet = redisService.client.get.bind(redisService.client);
      redisService.client.get = jest.fn().mockRejectedValue(new Error('Redis connection down'));

      try {
        const res = await request(app)
          .get('/api/v1/auth/me')
          .set('Authorization', 'Bearer valid-firebase-token');

        // Must fail closed with 503, NEVER permit access when revocation state cannot be verified
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('REDIS_UNAVAILABLE');
      } finally {
        redisService.client.get = originalGet;
      }
    });
  });

  // ===========================================================================
  // TEST 13: SPOOFED X-FORWARDED-FOR CANNOT BYPASS IP RATE LIMITING
  // ===========================================================================
  describe('Test 13: Spoofed X-Forwarded-For cannot bypass IP rate limiting', () => {
    it('rejects spoofed X-Forwarded-For when proxy is untrusted', async () => {
      // Default app has trust proxy = false.
      // An attacker attempts 25 requests with different spoofed X-Forwarded-For headers.
      // Because proxy is untrusted, all requests are attributed to the actual socket IP.
      const ipBurst = [];
      for (let i = 0; i < 22; i += 1) {
        ipBurst.push(
          request(app)
            .post('/api/v1/auth/send-otp')
            .set('X-Forwarded-For', `198.51.100.${i}`) // Spoofed IP header
            .send({ phone: `987650${String(100 + i).padStart(4, '0')}`, countryCode: '+91' }),
        );
      }

      const responses = await Promise.all(ipBurst);
      const rateLimited = responses.filter((r) => r.status === 429 && r.body.code === 'AUTH_RATE_LIMITED');

      // The rate limiter must catch the burst on the socket IP and block after limit (20)
      expect(rateLimited.length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // TEST 14: LEGITIMATE PROXY IP HANDLING WORKS WHEN CORRECTLY CONFIGURED
  // ===========================================================================
  describe('Test 14: Legitimate proxy IP handling works when correctly configured', () => {
    it('correctly uses client IP from trusted proxy when trust proxy is configured', async () => {
      const proxyApp = express();
      // Configure trusted proxy (e.g. 1 hop or loopback)
      proxyApp.set('trust proxy', 'loopback');
      proxyApp.get('/test/ip', (req, res) => {
        res.json({ clientIp: req.ip });
      });

      const res = await request(proxyApp)
        .get('/test/ip')
        .set('X-Forwarded-For', '203.0.113.195');

      // Express trusts loopback supertest connection and uses X-Forwarded-For as req.ip
      expect(res.body.clientIp).toBe('203.0.113.195');
    });
  });
});
