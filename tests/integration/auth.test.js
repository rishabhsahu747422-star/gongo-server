'use strict';

const request = require('supertest');
const { newDb, DataType } = require('pg-mem');
const crypto = require('crypto');
const { pool } = require('../../src/config/database');
const { setMockFirebaseAuth } = require('../../src/config/firebase');
const redisService = require('../../src/services/redis.service');
const otpService = require('../../src/services/otp.service');
const { createApp } = require('../../src/app');
const migration = require('../../database/migrations/1726300000000_create-users-table');

describe('Customer Authentication Integration Tests', () => {
  let app;
  let db;
  let mockPool;
  let mockFirebaseAuth;

  beforeAll(async () => {
    // 1. Initialize hermetic in-memory Postgres
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

    // 2. Configure mock Firebase Auth
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
        if (token === 'invalid-token') {
          const err = new Error('Invalid token');
          err.code = 'auth/argument-error';
          throw err;
        }
        return {
          uid: 'firebase-uid-test',
          auth_time: Math.floor(Date.now() / 1000) - 60,
          phone_number: '+919876543210',
          role: 'customer',
        };
      }),
      revokeRefreshTokens: jest.fn().mockResolvedValue(undefined),
    };
    setMockFirebaseAuth(mockFirebaseAuth);

    app = createApp();
  });

  afterEach(async () => {
    // Clear all test keys in Redis mock
    if (redisService.client && typeof redisService.client.flushall === 'function') {
      await redisService.client.flushall();
    }
  });

  describe('POST /api/v1/auth/send-otp', () => {
    it('should successfully send OTP to a valid Indian mobile number', async () => {
      const res = await request(app)
        .post('/api/v1/auth/send-otp')
        .send({ phone: '9876543210', countryCode: '+91' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('OTP sent successfully');
      expect(res.body.data).toBeDefined();
      expect(res.body.data.verificationId).toBeDefined();
      expect(res.body.data.expiresIn).toBe(300);
      expect(res.body.data.resendAfter).toBe(30);

      // CRITICAL SECURITY: OTP must NEVER be returned in response
      expect(res.body.data.otp).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toMatch(/\b\d{6}\b/);
    });

    it('should reject requests with missing phone number', async () => {
      const res = await request(app)
        .post('/api/v1/auth/send-otp')
        .send({ countryCode: '+91' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('should reject invalid Indian phone numbers', async () => {
      // Starts with 1 (invalid telecom prefix)
      const res = await request(app)
        .post('/api/v1/auth/send-otp')
        .send({ phone: '1234567890', countryCode: '+91' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_PHONE_FORMAT');
    });

    it('should enforce cooldown if requesting OTP again immediately', async () => {
      await request(app)
        .post('/api/v1/auth/send-otp')
        .send({ phone: '9876543211', countryCode: '+91' });

      // Immediate second request
      const res = await request(app)
        .post('/api/v1/auth/send-otp')
        .send({ phone: '9876543211', countryCode: '+91' });

      expect(res.status).toBe(429);
      expect(res.body.code).toBe('AUTH_COOLDOWN_ACTIVE');
    });
  });

  describe('POST /api/v1/auth/verify-otp', () => {
    let verificationId;
    const knownOtp = '123456';
    const testPhone = '9876543212';

    beforeEach(async () => {
      verificationId = otpService.generateVerificationId();
      const hashedOtp = otpService.hashOtp(knownOtp);
      await redisService.setOtpState(verificationId, {
        countryCode: '+91',
        phone: testPhone,
        hashedOtp,
        attempts: 0,
        createdAt: Date.now(),
      }, 300);
    });

    it('should successfully verify valid OTP and return customer credentials', async () => {
      const res = await request(app)
        .post('/api/v1/auth/verify-otp')
        .send({ verificationId, otp: knownOtp });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.customToken).toBeDefined();
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.user).toMatchObject({
        role: 'customer',
        phone: testPhone,
        countryCode: '+91',
      });
    });

    it('should prevent OTP reuse / replay attack', async () => {
      // First verification succeeds
      const res1 = await request(app)
        .post('/api/v1/auth/verify-otp')
        .send({ verificationId, otp: knownOtp });
      expect(res1.status).toBe(200);

      // Replay attack with same OTP and verificationId must fail
      const res2 = await request(app)
        .post('/api/v1/auth/verify-otp')
        .send({ verificationId, otp: knownOtp });
      expect(res2.status).toBe(400);
      expect(res2.body.code).toBe('AUTH_OTP_EXPIRED');
    });

    it('should reject invalid OTP and increment attempts', async () => {
      const res = await request(app)
        .post('/api/v1/auth/verify-otp')
        .send({ verificationId, otp: '999999' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('AUTH_INVALID_OTP');

      // Dedicated atomic counter should show 1 attempt
      const attempts = await redisService.getOtpAttemptCount(verificationId);
      expect(attempts).toBe(1);
    });

    it('should lock out after maximum failed attempts', async () => {
      // Send 5 incorrect attempts
      for (let i = 0; i < 4; i += 1) {
        await request(app)
          .post('/api/v1/auth/verify-otp')
          .send({ verificationId, otp: '000000' });
      }

      // 5th attempt exceeds limit and invalidates session
      const res5 = await request(app)
        .post('/api/v1/auth/verify-otp')
        .send({ verificationId, otp: '000000' });

      expect(res5.status).toBe(400);
      expect(res5.body.code).toBe('AUTH_OTP_ATTEMPTS_EXCEEDED');

      // State is consumed / deleted
      const state = await redisService.getOtpState(verificationId);
      expect(state).toBeNull();
    });

    it('should reject expired or non-existent verificationId', async () => {
      const res = await request(app)
        .post('/api/v1/auth/verify-otp')
        .send({
          verificationId: '00000000-0000-4000-8000-000000000000',
          otp: '123456',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('AUTH_OTP_EXPIRED');
    });
  });

  describe('Security: Privilege Escalation & Impersonation Prevention', () => {
    it('should ignore client-supplied role=admin and enforce role=customer', async () => {
      const vId = otpService.generateVerificationId();
      await redisService.setOtpState(vId, {
        countryCode: '+91',
        phone: '9876543299',
        hashedOtp: otpService.hashOtp('111222'),
        attempts: 0,
      }, 300);

      // Client attempts privilege escalation by injecting role: 'admin' and a fake userId
      const res = await request(app)
        .post('/api/v1/auth/verify-otp')
        .send({
          verificationId: vId,
          otp: '111222',
          role: 'admin',
          userId: '00000000-0000-0000-0000-000000000001',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.user.role).toBe('customer');

      // Verify in database: user in database MUST have role 'customer'
      const rows = db.public.many("SELECT role FROM users WHERE phone = '9876543299'");
      expect(rows[0].role).toBe('customer');
    });
  });

  describe('GET /api/v1/auth/me', () => {
    let customerUser;

    beforeAll(async () => {
      // Create test customer in database
      const row = db.public.one(`
        INSERT INTO users (phone, country_code, role, auth_provider, auth_id, is_active)
        VALUES ('9876543210', '+91', 'customer', 'firebase', 'firebase-uid-test', true)
        RETURNING *;
      `);
      customerUser = row;
    });

    it('should return profile for authenticated user', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer valid-firebase-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.phone).toBe('9876543210');
      expect(res.body.data.role).toBe('customer');
    });

    it('should reject unauthenticated request without Authorization header', async () => {
      const res = await request(app).get('/api/v1/auth/me');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_MISSING_CREDENTIAL');
    });

    it('should reject expired Firebase credentials', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer expired-token');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_EXPIRED_CREDENTIAL');
    });

    it('should reject invalid Firebase credentials', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer invalid-token');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_INVALID_CREDENTIAL');
    });

    it('should reject deactivated / inactive users', async () => {
      // Deactivate user in database
      db.public.none(`UPDATE users SET is_active = false WHERE id = '${customerUser.id}'`);

      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer valid-firebase-token');

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AUTH_USER_INACTIVE');

      // Re-activate for other tests
      db.public.none(`UPDATE users SET is_active = true WHERE id = '${customerUser.id}'`);
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    it('should revoke session and invalidate subsequent requests', async () => {
      // 1. Successful logout
      const logoutRes = await request(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', 'Bearer valid-firebase-token');

      expect(logoutRes.status).toBe(200);
      expect(logoutRes.body.success).toBe(true);
      expect(mockFirebaseAuth.revokeRefreshTokens).toHaveBeenCalled();

      // 2. Subsequent request with the now-revoked session must be blocked
      const meRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer valid-firebase-token');

      expect(meRes.status).toBe(401);
      expect(meRes.body.code).toBe('AUTH_SESSION_REVOKED');
    });
  });

  describe('POST /api/v1/auth/refresh', () => {
    it('should return safe guidance requiring Firebase client SDK refresh without minting arbitrary tokens', async () => {
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ token: 'valid-firebase-token' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.clientRefreshRequired).toBe(true);
      expect(res.body.data.customToken).toBeUndefined();
      expect(res.body.data.clientFlow).toBeDefined();
    });

    it('should reject refresh without token payload', async () => {
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });
});
