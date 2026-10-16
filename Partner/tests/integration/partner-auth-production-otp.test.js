'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { redisClient } = require('../../src/providers/redis');
const PartnerRepository = require('../../src/repositories/partner.repository');
const UserRepository = require('../../src/repositories/user.repository');
const ShopRepository = require('../../src/repositories/shop.repository');
const BankAccountRepository = require('../../src/repositories/bank-account.repository');
const renflairProvider = require('../../src/providers/renflair.provider');
const env = require('../../src/config/env');

describe('Integration: Partner Production OTP & Dev Login Separation', () => {
  let app;
  const existingPartnerPhone = '8989232398';
  const partnerAuthId = 'partner-prod-otp-auth-id';
  const partnerId = 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d';
  const userId = 'b2c3d4e5-f6a7-8b9c-0d1e-2f3a4b5c6d7e';

  beforeAll(() => {
    app = createApp();
  });

  afterAll(() => {
    PartnerRepository.setMockPartnerResolver(null);
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(renflairProvider, 'sendOtp').mockResolvedValue({
      success: true,
      simulated: true,
      messageId: `test_${Date.now()}`,
    });

    // Clean up Redis keys
    await redisClient.del(`partner:otp:${existingPartnerPhone}`);
    await redisClient.del(`partner:otp:cooldown:${existingPartnerPhone}`);
    await redisClient.del(`partner:otp:attempts:${existingPartnerPhone}`);
    await redisClient.del(`partner:lock:otp:verify:${existingPartnerPhone}`);

    // Mock partner repository
    PartnerRepository.setMockPartnerResolver((idOrAuth) => {
      if (idOrAuth === partnerAuthId || idOrAuth === partnerId || idOrAuth === existingPartnerPhone) {
        return {
          id: partnerId,
          partnerId,
          userId,
          auth_id: partnerAuthId,
          name: 'Partner Renflair User',
          phone: `+91 ${existingPartnerPhone}`,
          email: 'partner.renflair@gongo.in',
          role: 'PARTNER',
          kyc_status: 'VERIFIED',
          partner_status: 'ONLINE',
          rating: 4.8,
          review_count: 5,
          registered_since: 'Feb 2025',
          shop_name: 'Renflair Hub',
          city: 'Bhopal',
          is_active: true,
        };
      }
      if (idOrAuth === 'dev-partner-auth-id' || idOrAuth === '9999999999' || idOrAuth === 'dev-partner-id-123') {
        return {
          id: 'dev-partner-id-123',
          partnerId: 'dev-partner-id-123',
          userId: 'dev-user-id-123',
          auth_id: 'dev-partner-auth-id',
          name: 'Development Partner',
          phone: '+91 9999999999',
          email: 'dev.partner@gongo.in',
          role: 'PARTNER',
          kyc_status: 'VERIFIED',
          partner_status: 'ONLINE',
          is_active: true,
        };
      }
      return null;
    });

    // Mock user repository
    jest.spyOn(UserRepository.prototype, 'findByPhone').mockImplementation(async (phone) => {
      const clean = String(phone).replace(/[^0-9]/g, '').slice(-10);
      if (clean === existingPartnerPhone) {
        return {
          id: userId,
          auth_id: partnerAuthId,
          phone: clean,
          email: 'partner.renflair@gongo.in',
          role: 'PARTNER',
          is_active: true,
        };
      }
      if (clean === '9999999999') {
        return {
          id: 'dev-user-id-123',
          auth_id: 'dev-partner-auth-id',
          phone: clean,
          email: 'dev.partner@gongo.in',
          role: 'PARTNER',
          is_active: true,
        };
      }
      return null;
    });

    jest.spyOn(ShopRepository.prototype, 'findByPartnerId').mockResolvedValue({
      id: 'shop-renflair-1',
      shop_name: 'Renflair Hub',
      city: 'Bhopal',
      is_active: true,
    });

    jest.spyOn(BankAccountRepository.prototype, 'findPrimaryByPartnerId').mockResolvedValue({
      id: 'bank-renflair-1',
      bank_name: 'SBI',
      is_primary: true,
      verification_status: 'VERIFIED',
    });

    jest.spyOn(PartnerRepository.prototype, 'countVehicles').mockResolvedValue(2);
  });

  describe('1. Production Partner OTP: Send (POST /api/v1/auth/partner/send-otp)', () => {
    it('successfully sends 6-digit OTP and writes to partner:otp:{phone} and partner:otp:cooldown:{phone}', async () => {
      const res = await request(app)
        .post('/api/v1/auth/partner/send-otp')
        .send({ phone: existingPartnerPhone });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.phone).toBe(existingPartnerPhone);
      expect(res.body.data.cooldown).toBe(30);
      expect(res.body.data.expiresIn).toBe(300);

      // Verify that the dedicated Redis key partner:otp:{phone} is used
      const stored = await redisClient.get(`partner:otp:${existingPartnerPhone}`);
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored);
      expect(parsed).toHaveProperty('otpHash');
      expect(parsed).toHaveProperty('salt');
      expect(parsed.otp).toBeUndefined(); // NEVER plaintext

      // Verify cooldown key
      const cooldownTtl = await redisClient.ttl(`partner:otp:cooldown:${existingPartnerPhone}`);
      expect(cooldownTtl).toBeGreaterThan(0);
      expect(cooldownTtl).toBeLessThanOrEqual(30);
    });

    it('enforces 30s resend cooldown with 429 Too Many Requests', async () => {
      // First send
      await request(app)
        .post('/api/v1/auth/partner/send-otp')
        .send({ phone: existingPartnerPhone });

      // Immediate second send
      const res2 = await request(app)
        .post('/api/v1/auth/partner/send-otp')
        .send({ phone: existingPartnerPhone });

      expect(res2.status).toBe(429);
      expect(res2.body.success).toBe(false);
      expect(res2.body.error.message).toMatch(/Please wait \d+ seconds/);
    });

    it('rejects invalid mobile numbers with 400', async () => {
      const res = await request(app)
        .post('/api/v1/auth/partner/send-otp')
        .send({ phone: '12345' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('2. Production Partner OTP: Verify (POST /api/v1/auth/partner/verify-otp)', () => {
    let validOtp;

    beforeEach(async () => {
      const sendRes = await request(app)
        .post('/api/v1/auth/partner/send-otp')
        .send({ phone: existingPartnerPhone });
      validOtp = sendRes.body.data.devOtp;
    });

    it('returns PARTNER_NOT_FOUND (404) if mobile number does not belong to a partner', async () => {
      const unknownPhone = '9111111111';
      await redisClient.del(`partner:otp:${unknownPhone}`);
      await redisClient.del(`partner:otp:cooldown:${unknownPhone}`);

      const sendRes = await request(app)
        .post('/api/v1/auth/partner/send-otp')
        .send({ phone: unknownPhone });
      const otp = sendRes.body.data.devOtp;

      const verifyRes = await request(app)
        .post('/api/v1/auth/partner/verify-otp')
        .send({ phone: unknownPhone, otp });

      expect(verifyRes.status).toBe(404);
      expect(verifyRes.body.success).toBe(false);
      expect(verifyRes.body.code).toBe('PARTNER_NOT_FOUND');
      expect(verifyRes.body.message).toBe('No partner account found with this mobile number.');
    });

    it('enforces 3-attempt lockout: Attempt 1 returns INVALID_OTP with attemptsRemaining: 2', async () => {
      const res = await request(app)
        .post('/api/v1/auth/partner/verify-otp')
        .send({ phone: existingPartnerPhone, otp: '000000' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('INVALID_OTP');
      expect(res.body.message).toBe('Invalid OTP');
      expect(res.body.data).toEqual({ attemptsRemaining: 2 });
    });

    it('enforces 3-attempt lockout: Attempt 2 returns INVALID_OTP with attemptsRemaining: 1', async () => {
      await request(app)
        .post('/api/v1/auth/partner/verify-otp')
        .send({ phone: existingPartnerPhone, otp: '000000' });

      const res = await request(app)
        .post('/api/v1/auth/partner/verify-otp')
        .send({ phone: existingPartnerPhone, otp: '000000' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('INVALID_OTP');
      expect(res.body.data).toEqual({ attemptsRemaining: 1 });
    });

    it('enforces 3-attempt lockout: Attempt 3 purges OTP and returns OTP_ATTEMPTS_EXCEEDED with attemptsRemaining: 0', async () => {
      await request(app)
        .post('/api/v1/auth/partner/verify-otp')
        .send({ phone: existingPartnerPhone, otp: '000000' });
      await request(app)
        .post('/api/v1/auth/partner/verify-otp')
        .send({ phone: existingPartnerPhone, otp: '000000' });

      const res = await request(app)
        .post('/api/v1/auth/partner/verify-otp')
        .send({ phone: existingPartnerPhone, otp: '000000' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('OTP_ATTEMPTS_EXCEEDED');
      expect(res.body.message).toBe('Too many incorrect attempts. Please try again.');
      expect(res.body.data).toEqual({ attemptsRemaining: 0 });

      // State MUST be purged from Redis
      const state = await redisClient.get(`partner:otp:${existingPartnerPhone}`);
      expect(state).toBeNull();
    });

    it('succeeds with correct OTP, purges Redis state, and returns authoritative session token', async () => {
      const res = await request(app)
        .post('/api/v1/auth/partner/verify-otp')
        .send({ phone: existingPartnerPhone, otp: validOtp });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('token');
      expect(res.body.data.isRegistered).toBe(true);
      expect(res.body.data.partner.id).toBe(partnerId);

      // Verify session was stored in Redis
      const session = await redisClient.get(`auth:session:${res.body.data.token}`);
      expect(session).not.toBeNull();
      const parsed = JSON.parse(session);
      expect(parsed.uid).toBe(partnerAuthId);
      expect(parsed.role).toBe('PARTNER');

      // Verify OTP key was purged to prevent reuse
      const state = await redisClient.get(`partner:otp:${existingPartnerPhone}`);
      expect(state).toBeNull();

      // Protected endpoint works with returned token
      const meRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${res.body.data.token}`);
      expect(meRes.status).toBe(200);
      expect(meRes.body.success).toBe(true);
      expect(meRes.body.data.partner.id).toBe(partnerId);
    });

    it('rejects suspended partner with 403 Forbidden', async () => {
      PartnerRepository.setMockPartnerResolver((idOrAuth) => {
        if (idOrAuth === partnerAuthId || idOrAuth === existingPartnerPhone) {
          return {
            id: partnerId,
            partnerId,
            userId,
            auth_id: partnerAuthId,
            partner_status: 'SUSPENDED',
            is_active: true,
          };
        }
        return null;
      });

      const res = await request(app)
        .post('/api/v1/auth/partner/verify-otp')
        .send({ phone: existingPartnerPhone, otp: validOtp });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('3. Development-Only Partner Dev Login (POST /api/v1/auth/partner/dev-login)', () => {
    it('authenticates dedicated development partner with valid dev credentials without touching Renflair or OTP Redis keys', async () => {
      const res = await request(app)
        .post('/api/v1/auth/partner/dev-login')
        .send({
          phone: '9999999999',
          devCode: '123456',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('token');
      expect(res.body.data.isRegistered).toBe(true);

      // Renflair must NEVER be called for Dev Login
      expect(renflairProvider.sendOtp).not.toHaveBeenCalled();

      // Production OTP keys must NEVER be set by Dev Login
      const devOtpState = await redisClient.get('partner:otp:9999999999');
      expect(devOtpState).toBeNull();

      // Session token grants access to protected Partner endpoints
      const meRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${res.body.data.token}`);
      expect(meRes.status).toBe(200);
      expect(meRes.body.success).toBe(true);
    });

    it('rejects invalid dev credentials with 401 INVALID_DEV_CREDENTIALS', async () => {
      const res = await request(app)
        .post('/api/v1/auth/partner/dev-login')
        .send({
          phone: '9999999999',
          devCode: 'wrong_code',
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('INVALID_DEV_CREDENTIALS');
      expect(res.body.message).toBe('Invalid development credentials.');
    });

    it('rejects Dev Login with DEV_LOGIN_DISABLED when PARTNER_DEV_LOGIN_ENABLED is false', async () => {
      const prevEnv = process.env.PARTNER_DEV_LOGIN_ENABLED;
      process.env.PARTNER_DEV_LOGIN_ENABLED = 'false';

      try {
        const res = await request(app)
          .post('/api/v1/auth/partner/dev-login')
          .send({
            phone: '9999999999',
            devCode: '123456',
          });

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe('DEV_LOGIN_DISABLED');
        expect(res.body.message).toBe('Development login is disabled.');
      } finally {
        if (prevEnv !== undefined) {
          process.env.PARTNER_DEV_LOGIN_ENABLED = prevEnv;
        } else {
          delete process.env.PARTNER_DEV_LOGIN_ENABLED;
        }
      }
    });

    it('rejects Dev Login with DEV_LOGIN_DISABLED when NODE_ENV is production even if enabled', async () => {
      const prevNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        const res = await request(app)
          .post('/api/v1/auth/partner/dev-login')
          .send({
            phone: '9999999999',
            devCode: '123456',
          });

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe('DEV_LOGIN_DISABLED');
      } finally {
        process.env.NODE_ENV = prevNodeEnv;
      }
    });
  });
});
