'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { redisClient } = require('../../src/providers/redis');
const PartnerRepository = require('../../src/repositories/partner.repository');
const UserRepository = require('../../src/repositories/user.repository');
const ShopRepository = require('../../src/repositories/shop.repository');
const BankAccountRepository = require('../../src/repositories/bank-account.repository');
const renflairProvider = require('../../src/providers/renflair.provider');

describe('Integration: Renflair OTP Login & Dev Bypass Coexistence', () => {
  let app;
  const partnerPhone = '9876543210';
  const partnerAuthId = 'test-otp-auth-id';
  const partnerId = 'dc3a5acd-8d03-45c0-8cb9-23d1b3ffd562';
  const userId = '9c84fa46-0cc7-4715-b5e5-e4ac97ac9646';

  beforeAll(async () => {
    app = createApp();
  });

  afterAll(async () => {
    PartnerRepository.setMockPartnerResolver(null);
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(renflairProvider, 'sendOtp').mockResolvedValue({
      success: true,
      simulated: true,
      messageId: `test_${Date.now()}`,
    });

    // Clean up Redis test keys
    await redisClient.del(`otp:state:${partnerPhone}`);
    await redisClient.del(`otp:cooldown:${partnerPhone}`);
    await redisClient.del(`otp:attempts:${partnerPhone}`);
    await redisClient.del(`lock:otp:verify:${partnerPhone}`);

    // Mock partner and user repositories
    PartnerRepository.setMockPartnerResolver((idOrAuth) => {
      if (idOrAuth === partnerAuthId || idOrAuth === 'dev-partner-auth-id' || idOrAuth === partnerId) {
        return {
          id: partnerId,
          partnerId,
          userId,
          auth_id: idOrAuth === 'dev-partner-auth-id' ? 'dev-partner-auth-id' : partnerAuthId,
          name: 'GONGO Verified Partner',
          phone: `+91 ${partnerPhone}`,
          email: 'partner@gongo.in',
          role: 'PARTNER',
          kyc_status: 'VERIFIED',
          partner_status: 'ONLINE',
          rating: 5,
          review_count: 12,
          registered_since: 'Jan 2025',
          shop_name: 'GONGO Hub',
          shop_address: '100 Feet Road, Bangalore',
          city: 'Bangalore',
          is_active: true,
        };
      }
      return null;
    });

    jest.spyOn(UserRepository.prototype, 'findByPhone').mockImplementation(async (phone) => {
      const clean = String(phone).replace(/[^0-9]/g, '').slice(-10);
      if (clean === partnerPhone || clean === '9999999999') {
        return {
          id: userId,
          auth_id: clean === '9999999999' ? 'dev-partner-auth-id' : partnerAuthId,
          phone: clean,
          email: 'partner@gongo.in',
          role: 'PARTNER',
          is_active: true,
        };
      }
      return null;
    });

    jest.spyOn(ShopRepository.prototype, 'findByPartnerId').mockResolvedValue({
      id: 'shop-test-1',
      shop_name: 'GONGO Hub',
      shop_address: '100 Feet Road, Bangalore',
      city: 'Bangalore',
      is_active: true,
    });

    jest.spyOn(BankAccountRepository.prototype, 'findPrimaryByPartnerId').mockResolvedValue({
      id: 'bank-test-1',
      bank_name: 'HDFC Bank',
      account_holder_name: 'GONGO Verified Partner',
      account_number_masked: 'XXXXXXXX9012',
      ifsc_code: 'HDFC0001234',
      is_primary: true,
      verification_status: 'VERIFIED',
    });

    jest.spyOn(PartnerRepository.prototype, 'countVehicles').mockResolvedValue(3);
  });

  describe('1. Normal OTP Dispatch (POST /api/auth/otp/send & POST /api/v1/auth/otp/send)', () => {
    it('dispatches OTP successfully and stores hashed state with TTL', async () => {
      const res = await request(app)
        .post('/api/auth/otp/send')
        .send({ phone: partnerPhone });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.phone).toBe(partnerPhone);
      expect(res.body.data.cooldown).toBe(60);
      expect(res.body.data.expiresIn).toBe(300);

      // Verify that Redis state key was created
      const state = await redisClient.get(`otp:state:${partnerPhone}`);
      expect(state).not.toBeNull();
      const parsed = JSON.parse(state);
      expect(parsed).toHaveProperty('otpHash');
      expect(parsed).toHaveProperty('salt');
      // Plaintext OTP must NOT be stored in Redis
      expect(parsed.otp).toBeUndefined();
    });

    it('works under /api/v1/auth/otp/send identically', async () => {
      await redisClient.del(`otp:cooldown:${partnerPhone}`);
      const res = await request(app)
        .post('/api/v1/auth/otp/send')
        .send({ phone: partnerPhone });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.phone).toBe(partnerPhone);
    });

    it('rejects invalid mobile numbers with 400 ValidationError', async () => {
      const res = await request(app)
        .post('/api/auth/otp/send')
        .send({ phone: '123' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('enforces resend cooldown on immediate duplicate requests', async () => {
      await request(app).post('/api/auth/otp/send').send({ phone: partnerPhone });

      // Immediate retry within cooldown period
      const res = await request(app)
        .post('/api/auth/otp/send')
        .send({ phone: partnerPhone });

      expect(res.status).toBe(429);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(res.body.error.message).toMatch(/Please wait/);
    });
  });

  describe('2. OTP Verification & Attempt Limits', () => {
    let sentOtp;

    beforeEach(async () => {
      const res = await request(app)
        .post('/api/auth/otp/send')
        .send({ phone: partnerPhone });
      sentOtp = res.body.data.devOtp;
    });

    it('rejects malformed OTP format (< 6 digits) with 400', async () => {
      const res = await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone: partnerPhone, otp: '12' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('increments attempts on invalid OTP and reports remaining attempts', async () => {
      const res = await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone: partnerPhone, otp: '000000' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_TOKEN');
      expect(res.body.error.message).toMatch(/2 attempt\(s\) remaining/);

      const attempts = await redisClient.get(`otp:attempts:${partnerPhone}`);
      expect(parseInt(attempts, 10)).toBe(1);
    });

    it('locks out and invalidates OTP state after exceeding attempt limit (3 attempts)', async () => {
      // Attempt 1
      await request(app).post('/api/auth/otp/verify').send({ phone: partnerPhone, otp: '000001' });
      // Attempt 2
      await request(app).post('/api/auth/otp/verify').send({ phone: partnerPhone, otp: '000002' });
      // Attempt 3 (Exhausts limit)
      const res3 = await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone: partnerPhone, otp: '000003' });

      expect(res3.status).toBe(401);
      expect(res3.body.error.message).toMatch(/Maximum verification attempts exceeded/);

      // Verify OTP state was deleted
      const state = await redisClient.get(`otp:state:${partnerPhone}`);
      expect(state).toBeNull();
    });

    it('returns 401 when verifying non-existent or expired OTP', async () => {
      const res = await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone: '9111111111', otp: '123456' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_TOKEN');
      expect(res.body.error.message).toMatch(/expired or is invalid/);
    });

    it('prevents OTP reuse by immediately purging state on successful verification', async () => {
      // First verification succeeds
      const res1 = await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone: partnerPhone, otp: sentOtp });

      expect(res1.status).toBe(200);
      expect(res1.body.success).toBe(true);

      // Immediate second attempt with same OTP must fail
      const res2 = await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone: partnerPhone, otp: sentOtp });

      expect(res2.status).toBe(401);
      expect(res2.body.error.code).toBe('INVALID_TOKEN');
      expect(res2.body.error.message).toMatch(/expired or is invalid/);
    });
  });

  describe('3. Authenticated Session & Protected Partner API Access', () => {
    let validOtp;

    beforeEach(async () => {
      await redisClient.del(`otp:cooldown:${partnerPhone}`);
      const res = await request(app)
        .post('/api/auth/otp/send')
        .send({ phone: partnerPhone });
      validOtp = res.body.data.devOtp;
    });

    it('establishes valid authenticated session with token, user and partner profile', async () => {
      const res = await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone: partnerPhone, otp: validOtp });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isRegistered).toBe(true);
      expect(res.body.data).toHaveProperty('token');
      expect(typeof res.body.data.token).toBe('string');
      expect(res.body.data.user).toMatchObject({
        id: userId,
        role: 'PARTNER',
      });
      expect(res.body.data.partner).toMatchObject({
        id: partnerId,
        kycStatus: 'VERIFIED',
        partnerStatus: 'ONLINE',
      });

      // Verify session exists in Redis
      const session = await redisClient.get(`auth:session:${res.body.data.token}`);
      expect(session).not.toBeNull();
      const parsed = JSON.parse(session);
      expect(parsed.uid).toBe(partnerAuthId);
    });

    it('allows protected Partner API access using Bearer token from OTP login', async () => {
      const loginRes = await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone: partnerPhone, otp: validOtp });

      const sessionToken = loginRes.body.data.token;

      // Access protected GET /api/v1/auth/me
      const meRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${sessionToken}`);

      expect(meRes.status).toBe(200);
      expect(meRes.body.success).toBe(true);
      expect(meRes.body.data.partner.id).toBe(partnerId);
      expect(meRes.body.data.partner.kycStatus).toBe('VERIFIED');
    });

    it('revokes session token upon calling POST /api/v1/auth/logout', async () => {
      const loginRes = await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone: partnerPhone, otp: validOtp });

      const sessionToken = loginRes.body.data.token;

      // Logout
      const logoutRes = await request(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${sessionToken}`);

      expect(logoutRes.status).toBe(200);
      expect(logoutRes.body.success).toBe(true);

      // Verify token was deleted from Redis
      const sessionInRedis = await redisClient.get(`auth:session:${sessionToken}`);
      expect(sessionInRedis).toBeNull();
    });

    it('returns valid registration token and isRegistered: false for new unregistered phone', async () => {
      const newPhone = '9777777777';
      await redisClient.del(`otp:cooldown:${newPhone}`);
      await redisClient.del(`otp:state:${newPhone}`);
      await redisClient.del(`otp:attempts:${newPhone}`);
      await redisClient.del(`lock:otp:verify:${newPhone}`);
      const sendRes = await request(app)
        .post('/api/auth/otp/send')
        .send({ phone: newPhone });
      expect(sendRes.status).toBe(200);
      const newOtp = sendRes.body.data.devOtp;

      const verifyRes = await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone: newPhone, otp: newOtp });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.success).toBe(true);
      expect(verifyRes.body.data.isRegistered).toBe(false);
      expect(verifyRes.body.data).toHaveProperty('token');
      expect(typeof verifyRes.body.data.token).toBe('string');

      // Verify registration token exists in Redis
      const redisSession = await redisClient.get(`auth:session:${verifyRes.body.data.token}`);
      expect(redisSession).not.toBeNull();
      const parsed = JSON.parse(redisSession);
      expect(parsed.phone).toBe(newPhone);
      expect(parsed.role).toBe('PARTNER');
    });
  });

  describe('4. Preservation of Dev Bypass Login (Zero Regression)', () => {
    it('Dev Bypass Login continues to function independently without OTP', async () => {
      const res = await request(app)
        .post('/api/v1/auth/dev-login')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.token).toBe('dev-partner-token');
      expect(res.body.data.isRegistered).toBe(true);
      expect(res.body.data.partner.id).toBe(partnerId);
    });

    it('Bearer dev-partner-token authenticates protected endpoints as before', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer dev-partner-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.partner.id).toBe(partnerId);
    });

    it('Dev Bypass and OTP flows operate concurrently without mutual interference', async () => {
      await redisClient.del(`otp:cooldown:${partnerPhone}`);
      // 1. Send OTP for partner phone
      const sendRes = await request(app)
        .post('/api/auth/otp/send')
        .send({ phone: partnerPhone });
      const otp = sendRes.body.data.devOtp;

      // 2. Dev login occurs
      const devRes = await request(app)
        .post('/api/v1/auth/dev-login')
        .send({});
      expect(devRes.body.data.token).toBe('dev-partner-token');

      // 3. Normal OTP verification occurs
      const otpRes = await request(app)
        .post('/api/auth/otp/verify')
        .send({ phone: partnerPhone, otp });
      expect(otpRes.status).toBe(200);
      expect(otpRes.body.data.token).not.toBe('dev-partner-token');

      // 4. Both tokens are valid simultaneously for their respective sessions
      const devAccess = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${devRes.body.data.token}`);
      expect(devAccess.status).toBe(200);

      const otpAccess = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${otpRes.body.data.token}`);
      expect(otpAccess.status).toBe(200);
    });
  });
});
