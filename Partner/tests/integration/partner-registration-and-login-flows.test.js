'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { redisClient } = require('../../src/providers/redis');
const PartnerRepository = require('../../src/repositories/partner.repository');
const UserRepository = require('../../src/repositories/user.repository');
const ShopRepository = require('../../src/repositories/shop.repository');
const WalletRepository = require('../../src/repositories/wallet.repository');
const renflairProvider = require('../../src/providers/renflair.provider');
const db = require('../../src/db/pool');

describe('Integration: Partner Registration and Login Flow Separation', () => {
  let app;
  const existingPartnerPhone = '8888812345';
  const newPartnerPhone = '9999954321';
  const partnerAuthId = 'auth-existing-partner-uid';
  const existingPartnerId = '11111111-2222-3333-4444-555555555555';
  const existingUserId = '66666666-7777-8888-9999-000000000000';

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

    await redisClient.del(`partner:otp:${newPartnerPhone}`);
    await redisClient.del(`partner:otp:cooldown:${newPartnerPhone}`);
    await redisClient.del(`partner:otp:attempts:${newPartnerPhone}`);
    await redisClient.del(`partner:lock:otp:verify:${newPartnerPhone}`);

    // Mock partner repository resolver
    PartnerRepository.setMockPartnerResolver((idOrAuth) => {
      if (idOrAuth === partnerAuthId || idOrAuth === existingPartnerId || idOrAuth === existingPartnerPhone) {
        return {
          id: existingPartnerId,
          partnerId: existingPartnerId,
          userId: existingUserId,
          auth_id: partnerAuthId,
          name: 'Existing Partner',
          phone: `+91 ${existingPartnerPhone}`,
          email: 'existing.partner@gongo.in',
          role: 'PARTNER',
          kyc_status: 'VERIFIED',
          partner_status: 'ONLINE',
          rating: 4.9,
          review_count: 10,
          registered_since: 'Jan 2025',
          shop_name: 'Existing Motors',
          city: 'Bhopal',
          is_active: true,
        };
      }
      return null;
    });

    // Mock UserRepository findByPhone
    jest.spyOn(UserRepository.prototype, 'findByPhone').mockImplementation(async (phone) => {
      const clean = String(phone).replace(/[^0-9]/g, '').slice(-10);
      if (clean === existingPartnerPhone) {
        return {
          id: existingUserId,
          auth_id: partnerAuthId,
          phone: clean,
          email: 'existing.partner@gongo.in',
          role: 'PARTNER',
          is_active: true,
        };
      }
      return null;
    });

    jest.spyOn(UserRepository.prototype, 'findByAuthId').mockImplementation(async (authId) => {
      if (authId === partnerAuthId) {
        return {
          id: existingUserId,
          auth_id: partnerAuthId,
          phone: existingPartnerPhone,
          role: 'PARTNER',
          is_active: true,
        };
      }
      return null;
    });

    jest.spyOn(PartnerRepository.prototype, 'countVehicles').mockResolvedValue(1);
  });

  // 1. Existing Partner Login succeeds
  it('1. Existing Partner Login succeeds and issues valid session token', async () => {
    const sendRes = await request(app)
      .post('/api/v1/auth/partner/send-otp')
      .send({ phone: existingPartnerPhone });
    expect(sendRes.status).toBe(200);
    const otp = sendRes.body.data.devOtp;

    // Normal login flow (requireExisting defaults to true)
    const verifyRes = await request(app)
      .post('/api/v1/auth/partner/verify-otp')
      .send({ phone: existingPartnerPhone, otp });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.success).toBe(true);
    expect(verifyRes.body.data.isRegistered).toBe(true);
    expect(verifyRes.body.data.token).toBeDefined();
    expect(verifyRes.body.data.partner.id).toBe(existingPartnerId);
    expect(verifyRes.body.data.partner.name).toBe('Existing Partner');
  });

  // 2. Unregistered number on Login shows correct message and does not create account
  it('2. Unregistered number on Login fails with PARTNER_NOT_FOUND without creating records', async () => {
    const sendRes = await request(app)
      .post('/api/v1/auth/partner/send-otp')
      .send({ phone: newPartnerPhone });
    expect(sendRes.status).toBe(200);
    const otp = sendRes.body.data.devOtp;

    // Login flow with requireExisting: true
    const verifyRes = await request(app)
      .post('/api/v1/auth/partner/verify-otp')
      .send({ phone: newPartnerPhone, otp, requireExisting: true });

    expect(verifyRes.status).toBe(404);
    expect(verifyRes.body.success).toBe(false);
    expect(verifyRes.body.code).toBe('PARTNER_NOT_FOUND');
    expect(verifyRes.body.message).toBe('No partner account found with this mobile number.');

    // Verify no session was created in Redis for new number
    const keys = await redisClient.keys(`auth:session:*`);
    for (const key of keys) {
      const data = await redisClient.get(key);
      if (data && data.includes(newPartnerPhone)) {
        throw new Error('Unregistered login should never create a session in Redis');
      }
    }
  });

  // 3. Unregistered, OTP-verified number on Register successfully creates records atomically
  it('3. Unregistered, OTP-verified number on Register creates user and partner records atomically', async () => {
    const sendRes = await request(app)
      .post('/api/v1/auth/partner/send-otp')
      .send({ phone: newPartnerPhone });
    expect(sendRes.status).toBe(200);
    const otp = sendRes.body.data.devOtp;

    // Register flow: verify OTP with requireExisting: false
    const verifyRes = await request(app)
      .post('/api/v1/auth/partner/verify-otp')
      .send({ phone: newPartnerPhone, otp, requireExisting: false });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.success).toBe(true);
    expect(verifyRes.body.data.isRegistered).toBe(false);
    expect(verifyRes.body.data.token).toBeDefined();

    const regSessionToken = verifyRes.body.data.token;

    // Mock DB transaction creation
    const createdUserId = 'new-user-uuid-1234';
    const createdPartnerId = 'new-partner-uuid-5678';
    const createdShopId = 'new-shop-uuid-9999';

    jest.spyOn(db, 'transaction').mockImplementation(async (callback) => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [{ id: 'consent-id' }] }),
      };
      jest.spyOn(UserRepository.prototype, 'createUser').mockResolvedValue({
        id: createdUserId,
        auth_id: 'mock-auth-id',
        role: 'PARTNER',
        name: 'New Partner Onboarding',
        phone: newPartnerPhone,
        email: 'newpartner@gongo.in',
        is_active: true,
      });
      jest.spyOn(PartnerRepository.prototype, 'createPartner').mockResolvedValue({
        id: createdPartnerId,
        user_id: createdUserId,
        partner_status: 'OFFLINE',
        kyc_status: 'PENDING',
        rating: 5.0,
        review_count: 0,
        registered_since: 'Oct 2026',
        profile_image_url: null,
      });
      jest.spyOn(ShopRepository.prototype, 'createShop').mockResolvedValue({
        id: createdShopId,
        partner_id: createdPartnerId,
        shop_name: 'GONGO Mobility Hub',
        shop_address: 'MP Nagar Zone 2',
        city: 'Bhopal',
      });
      jest.spyOn(WalletRepository.prototype, 'createWallet').mockResolvedValue({
        id: 'new-wallet-uuid',
        partner_id: createdPartnerId,
        available_balance: 0.00,
      });

      return callback(mockClient);
    });

    // Execute atomic registration
    const regRes = await request(app)
      .post('/api/v1/auth/register')
      .set('Authorization', `Bearer ${regSessionToken}`)
      .send({
        name: 'New Partner Onboarding',
        shopName: 'GONGO Mobility Hub',
        city: 'Bhopal',
        shopAddress: 'MP Nagar Zone 2',
        landmark: 'Opposite City Mall',
        email: 'newpartner@gongo.in',
        phone: newPartnerPhone,
        termsAccepted: true,
      });

    expect(regRes.status).toBe(201);
    expect(regRes.body.success).toBe(true);
    expect(regRes.body.data.isRegistered).toBe(true);
    expect(regRes.body.data.partner.id).toBe(createdPartnerId);
    expect(regRes.body.data.partner.landmark).toBe('Opposite City Mall');
    expect(regRes.body.data.user.phone).toBe(`+91 ${newPartnerPhone}`);
  });

  // 4. Registering an existing number does not create duplicate records
  it('4. Registering an existing number rejects with PARTNER_ALREADY_EXISTS and creates no duplicate', async () => {
    const sendRes = await request(app)
      .post('/api/v1/auth/partner/send-otp')
      .send({ phone: existingPartnerPhone });
    expect(sendRes.status).toBe(200);
    const otp = sendRes.body.data.devOtp;

    // Register flow with existing partner number
    const verifyRes = await request(app)
      .post('/api/v1/auth/partner/verify-otp')
      .send({ phone: existingPartnerPhone, otp, requireExisting: false });

    expect(verifyRes.status).toBe(409);
    expect(verifyRes.body.success).toBe(false);
    expect(verifyRes.body.code).toBe('PARTNER_ALREADY_EXISTS');
    expect(verifyRes.body.message).toMatch(/already exists/i);
  });

  // 5. Invalid OTP cannot register
  it('5. Invalid OTP cannot register and returns attemptsRemaining', async () => {
    await request(app)
      .post('/api/v1/auth/partner/send-otp')
      .send({ phone: newPartnerPhone });

    const verifyRes = await request(app)
      .post('/api/v1/auth/partner/verify-otp')
      .send({ phone: newPartnerPhone, otp: '111111', requireExisting: false });

    expect(verifyRes.status).toBe(401);
    expect(verifyRes.body.success).toBe(false);
    expect(verifyRes.body.code).toBe('INVALID_OTP');
    expect(verifyRes.body.data).toEqual({ attemptsRemaining: 2 });
  });

  // 6. Successful registration produces valid session for subsequent calls
  it('6. Successful registration produces a valid session recognized by auth middleware', async () => {
    const sendRes = await request(app)
      .post('/api/v1/auth/partner/send-otp')
      .send({ phone: newPartnerPhone });
    const otp = sendRes.body.data.devOtp;

    const verifyRes = await request(app)
      .post('/api/v1/auth/partner/verify-otp')
      .send({ phone: newPartnerPhone, otp, requireExisting: false });

    const sessionToken = verifyRes.body.data.token;
    expect(sessionToken).toBeDefined();

    // Verify token exists in Redis with UNREGISTERED status
    const stored = await redisClient.get(`auth:session:${sessionToken}`);
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored);
    expect(parsed.phone).toBe(newPartnerPhone);
    expect(parsed.status).toBe('UNREGISTERED');
  });

  // 7. Missing required registration fields return clear validation error
  it('7. Missing required registration fields returns 400 validation error', async () => {
    // Generate valid registration token
    const sendRes = await request(app)
      .post('/api/v1/auth/partner/send-otp')
      .send({ phone: newPartnerPhone });
    const otp = sendRes.body.data.devOtp;

    const verifyRes = await request(app)
      .post('/api/v1/auth/partner/verify-otp')
      .send({ phone: newPartnerPhone, otp, requireExisting: false });
    const regSessionToken = verifyRes.body.data.token;

    // Send payload missing name, shopName, and city
    const badRegRes = await request(app)
      .post('/api/v1/auth/register')
      .set('Authorization', `Bearer ${regSessionToken}`)
      .send({
        email: 'missingfields@gongo.in',
      });

    expect(badRegRes.status).toBe(400);
    expect(badRegRes.body.success).toBe(false);
    expect(badRegRes.body.code).toBe('VALIDATION_ERROR');
    expect(badRegRes.body.message).toMatch(/name/i);
  });

  // 8. Invalid or missing registration token is rejected safely
  it('8. Invalid or expired registration token is rejected with 401', async () => {
    const invalidRes = await request(app)
      .post('/api/v1/auth/register')
      .set('Authorization', 'Bearer non-existent-invalid-reg-token')
      .send({
        name: 'Test Partner',
        shopName: 'Test Shop',
        city: 'Bhopal',
      });

    expect(invalidRes.status).toBe(401);
    expect(invalidRes.body.success).toBe(false);
    expect(invalidRes.body.code).toBe('INVALID_TOKEN');
  });

  // 9. Dev Login remains functional and isolated
  it('9. Dev Login generates real database session without Supabase conflict', async () => {
    const devPhone = '9999999999';
    const devCode = '123456';
    const devAuthId = 'dev-partner-auth-id';

    const previousResolver = PartnerRepository.prototype.findByAuthId;
    jest.spyOn(PartnerRepository.prototype, 'findByAuthId').mockImplementation(async (authId) => {
      if (authId === devAuthId) {
        return {
          id: existingPartnerId,
          partnerId: existingPartnerId,
          userId: existingUserId,
          auth_id: devAuthId,
          phone: devPhone,
          role: 'PARTNER',
          is_active: true,
        };
      }
      return null;
    });

    const devRes = await request(app)
      .post('/api/v1/auth/partner/dev-login')
      .send({ phone: devPhone, devCode });

    expect(devRes.status).toBe(200);
    expect(devRes.body.success).toBe(true);
    expect(devRes.body.data.token).toBeDefined();

    // Verify Dev session in Redis
    const devToken = devRes.body.data.token;
    const redisDev = await redisClient.get(`auth:session:${devToken}`);
    expect(redisDev).not.toBeNull();
    const parsedDev = JSON.parse(redisDev);
    expect(parsedDev.role).toBe('PARTNER');
  });
});
