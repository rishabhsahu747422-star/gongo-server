'use strict';

const request = require('supertest');
const { newDb, DataType } = require('pg-mem');
const crypto = require('crypto');
const { pool } = require('../../src/config/database');
const redisService = require('../../src/services/redis.service');
const { createApp } = require('../../src/app');
const migration = require('../../database/migrations/1726300000000_create-users-table');

describe('Integration: Customer Mobile OTP Authentication (Renflair + Redis)', () => {
  let app;
  let db;
  let mockPool;

  beforeAll(async () => {
    // Hermetic in-memory Postgres via pg-mem
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

    app = createApp();
  });

  beforeEach(async () => {
    // Flush test Redis client
    await redisService.client.flushall();
  });

  describe('1. Send OTP (POST /api/v1/auth/customer/send-otp)', () => {
    it('successfully sends 6-digit OTP for valid 10-digit mobile number', async () => {
      const res = await request(app)
        .post('/api/v1/auth/customer/send-otp')
        .send({ phone: '8989232398' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('OTP sent successfully');
      expect(res.body.data).toHaveProperty('expiresIn', 300);
      expect(res.body.data).toHaveProperty('resendAfter', 30);

      // Verify Redis state key created with 5-minute TTL
      const stateRaw = await redisService.client.get('customer:otp:8989232398');
      expect(stateRaw).toBeDefined();
      const state = JSON.parse(stateRaw);
      expect(state.phone).toBe('8989232398');
      expect(state.attempts).toBe(0);
      expect(state.otpHash).toBeDefined();
      // Plaintext OTP is NEVER stored
      expect(state.otp).toBeUndefined();

      // Verify 30-second cooldown key
      const cooldown = await redisService.client.get('customer:otp:cooldown:8989232398');
      expect(cooldown).toBe('1');
    });

    it('normalizes international format (+918989232398) to 10-digit number', async () => {
      const res = await request(app)
        .post('/api/v1/auth/customer/send-otp')
        .send({ phone: '+918989232398' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const stateRaw = await redisService.client.get('customer:otp:8989232398');
      expect(stateRaw).toBeDefined();
    });

    it('rejects invalid or missing phone numbers with 400', async () => {
      const res1 = await request(app)
        .post('/api/v1/auth/customer/send-otp')
        .send({ phone: '12345' });

      expect(res1.status).toBe(400);
      expect(res1.body.success).toBe(false);

      const res2 = await request(app)
        .post('/api/v1/auth/customer/send-otp')
        .send({});

      expect(res2.status).toBe(400);
      expect(res2.body.success).toBe(false);
    });

    it('blocks rapid resend within 30 seconds with 429', async () => {
      // First send
      await request(app)
        .post('/api/v1/auth/customer/send-otp')
        .send({ phone: '8989232398' });

      // Immediate second send -> blocked by 30s cooldown
      const res = await request(app)
        .post('/api/v1/auth/customer/send-otp')
        .send({ phone: '8989232398' });

      expect(res.status).toBe(429);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('AUTH_COOLDOWN_ACTIVE');
    });
  });

  describe('2. Verify OTP & 3-Attempt Rule (POST /api/v1/auth/customer/verify-otp)', () => {
    it('enforces 3 wrong attempts rule and purges OTP on 3rd failure', async () => {
      const phone = '9876543210';

      // Send OTP
      const sendRes = await request(app)
        .post('/api/v1/auth/customer/send-otp')
        .send({ phone });
      expect(sendRes.status).toBe(200);

      // ── Wrong attempt 1 ──────────────────────────────
      const wrong1 = await request(app)
        .post('/api/v1/auth/customer/verify-otp')
        .send({ phone, otp: '000000' });

      expect(wrong1.status).toBe(400);
      expect(wrong1.body.success).toBe(false);
      expect(wrong1.body.code).toBe('INVALID_OTP');
      expect(wrong1.body.message).toBe('Invalid OTP');
      expect(wrong1.body.data).toEqual({ attemptsRemaining: 2 });

      // ── Wrong attempt 2 ──────────────────────────────
      const wrong2 = await request(app)
        .post('/api/v1/auth/customer/verify-otp')
        .send({ phone, otp: '111111' });

      expect(wrong2.status).toBe(400);
      expect(wrong2.body.success).toBe(false);
      expect(wrong2.body.code).toBe('INVALID_OTP');
      expect(wrong2.body.message).toBe('Invalid OTP');
      expect(wrong2.body.data).toEqual({ attemptsRemaining: 1 });

      // ── Wrong attempt 3 ──────────────────────────────
      const wrong3 = await request(app)
        .post('/api/v1/auth/customer/verify-otp')
        .send({ phone, otp: '222222' });

      expect(wrong3.status).toBe(400);
      expect(wrong3.body.success).toBe(false);
      expect(wrong3.body.code).toBe('OTP_ATTEMPTS_EXCEEDED');
      expect(wrong3.body.message).toBe('Too many incorrect attempts. Please try again.');
      expect(wrong3.body.data).toEqual({ attemptsRemaining: 0 });

      // Redis OTP must be completely purged
      const stateAfter = await redisService.client.get(`customer:otp:${phone}`);
      expect(stateAfter).toBeNull();

      // Subsequent attempt with even any OTP returns expired/not found
      const subsequent = await request(app)
        .post('/api/v1/auth/customer/verify-otp')
        .send({ phone, otp: '000000' });

      expect(subsequent.status).toBe(400);
      expect(subsequent.body.code).toBe('OTP_EXPIRED');
    });

    it('succeeds with correct OTP, provisions customer, mints session token and cleans up Redis', async () => {
      const phone = '9123456780';

      // Send OTP (devOtp exposed in test environment)
      const sendRes = await request(app)
        .post('/api/v1/auth/customer/send-otp')
        .send({ phone });
      expect(sendRes.status).toBe(200);
      const generatedOtp = sendRes.body.data.devOtp;
      expect(generatedOtp).toBeDefined();

      // Verify with correct OTP
      const verifyRes = await request(app)
        .post('/api/v1/auth/customer/verify-otp')
        .send({ phone, otp: generatedOtp });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.success).toBe(true);
      expect(verifyRes.body.message).toBe('Login successful');
      expect(verifyRes.body.data).toHaveProperty('accessToken');
      expect(verifyRes.body.data).toHaveProperty('refreshToken');
      expect(verifyRes.body.data.user).toMatchObject({
        phone: '9123456780',
        role: 'customer',
        isProfileComplete: false,
      });

      // OTP state deleted from Redis
      const state = await redisService.client.get(`customer:otp:${phone}`);
      expect(state).toBeNull();

      // Authoritative GET /api/v1/auth/me with session accessToken succeeds
      const accessToken = verifyRes.body.data.accessToken;
      const meRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(meRes.status).toBe(200);
      expect(meRes.body.success).toBe(true);
      expect(meRes.body.data.id).toBe(verifyRes.body.data.user.id);
      expect(meRes.body.data.role).toBe('customer');
    });

    it('logs in existing customer without creating duplicate record', async () => {
      const phone = '9988776655';

      // First verification creates customer
      const send1 = await request(app).post('/api/v1/auth/customer/send-otp').send({ phone });
      const verify1 = await request(app).post('/api/v1/auth/customer/verify-otp').send({
        phone,
        otp: send1.body.data.devOtp,
      });
      expect(verify1.status).toBe(200);
      const firstUserId = verify1.body.data.user.id;

      // Second verification for same phone
      const send2 = await request(app).post('/api/v1/auth/customer/send-otp').send({ phone: `+91${phone}` });
      const verify2 = await request(app).post('/api/v1/auth/customer/verify-otp').send({
        phone: `+91${phone}`,
        otp: send2.body.data.devOtp,
      });

      expect(verify2.status).toBe(200);
      expect(verify2.body.data.user.id).toBe(firstUserId);
    });
  });

  describe('4. Session Lifecycle Security', () => {
    const login = async (phone) => {
      const sendRes = await request(app).post('/api/v1/auth/customer/send-otp').send({ phone });
      const verifyRes = await request(app)
        .post('/api/v1/auth/customer/verify-otp')
        .send({ phone, otp: sendRes.body.data.devOtp });
      expect(verifyRes.status).toBe(200);
      return verifyRes.body.data;
    };

    it('does not accept a refresh token as an access token', async () => {
      const { refreshToken } = await login('9000000001');

      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${refreshToken}`);

      expect(res.status).toBe(401);
    });

    it('rejects the logged-out token while a fresh login works immediately', async () => {
      const phone = '9000000002';
      const first = await login(phone);

      const logoutRes = await request(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${first.accessToken}`);
      expect(logoutRes.status).toBe(200);

      const staleRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${first.accessToken}`);
      expect(staleRes.status).toBe(401);

      await redisService.client.del(`customer:otp:cooldown:${phone}`);
      const second = await login(phone);
      const freshRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${second.accessToken}`);
      expect(freshRes.status).toBe(200);
    });

    it('keeps the revocation marker for the full session lifetime', async () => {
      const { accessToken, user } = await login('9000000003');
      await request(app).post('/api/v1/auth/logout').set('Authorization', `Bearer ${accessToken}`);

      const ttl = await redisService.client.ttl(redisService.getKey('revoked', user.id));
      expect(ttl).toBeGreaterThan(3600);
    });
  });

  describe('3. Dev Login Integrity (DO NOT BREAK)', () => {
    it('confirms existing Dev Login token remains 100% operational', async () => {
      const devRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer dev-token-9999999999');

      expect(devRes.status).toBe(200);
      expect(devRes.body.success).toBe(true);
      expect(devRes.body.data.role).toBe('customer');
    });
  });
});
