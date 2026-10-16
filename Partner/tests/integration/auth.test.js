'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const UserRepository = require('../../src/repositories/user.repository');
const ShopRepository = require('../../src/repositories/shop.repository');
const WalletRepository = require('../../src/repositories/wallet.repository');
const poolModule = require('../../src/db/pool');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Integration: Partner Authentication & Session Flow', () => {
  let app;
  let mockAuth;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    // Setup Mock Firebase Auth Provider
    mockAuth = {
      verifyIdToken: jest.fn(async (token) => {
        if (token === 'valid-partner-token') {
          return { uid: 'uid-partner-1', phone_number: '+919876543210', email: 'vikram@gongo.in' };
        }
        if (token === 'unregistered-firebase-token') {
          return { uid: 'uid-new-partner', phone_number: '+919123456780', email: 'new@gongo.in' };
        }
        if (token === 'customer-token') {
          return { uid: 'uid-customer-1', phone_number: '+919999900000', email: 'cust@gongo.in' };
        }
        if (token === 'deactivated-token') {
          return { uid: 'uid-partner-deactivated', phone_number: '+919888877777' };
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
      revokeRefreshTokens: jest.fn().mockResolvedValue(true),
    };
    setMockFirebaseAuth(mockAuth);

    // Setup Mock Partner Repository Resolver for integration tests
    PartnerRepository.setMockPartnerResolver((authId) => {
      if (authId === 'uid-partner-1' || authId === 'partner-123') {
        return {
          id: 'partner-123',
          partnerId: 'partner-123',
          userId: 'user-123',
          auth_id: 'uid-partner-1',
          role: 'PARTNER',
          name: 'Vikram Sharma',
          phone: '9876543210',
          email: 'vikram@gongo.in',
          is_active: true,
          partner_status: 'ONLINE',
          kyc_status: 'VERIFIED',
          rating: 4.9,
          review_count: 42,
          registered_since: 'Nov 2024',
          profile_image_url: 'https://images.gongo.in/vikram.jpg',
        };
      }
      if (authId === 'uid-customer-1') {
        return {
          id: 'customer-999',
          partnerId: null,
          userId: 'customer-999',
          auth_id: 'uid-customer-1',
          role: 'CUSTOMER',
          name: 'Customer One',
          is_active: true,
          partner_status: null,
          kyc_status: null,
        };
      }
      if (authId === 'uid-partner-deactivated') {
        return {
          id: 'partner-deact',
          partnerId: 'partner-deact',
          userId: 'user-deact',
          auth_id: 'uid-partner-deactivated',
          role: 'PARTNER',
          is_active: false,
          partner_status: 'OFFLINE',
          kyc_status: 'SUSPENDED',
        };
      }
      return null;
    });
  });

  afterAll(() => {
    PartnerRepository.setMockPartnerResolver(null);
  });

  // ── 1. check-phone endpoint ──────────────────────────────────────
  describe('POST /api/v1/auth/check-phone', () => {
    it('returns isExisting: true for existing registered partner phone', async () => {
      jest.spyOn(UserRepository.prototype, 'findByPhone').mockResolvedValueOnce({
        id: 'u-1',
        role: 'PARTNER',
        phone: '9876543210',
        is_active: true,
      });

      const res = await request(app)
        .post('/api/v1/auth/check-phone')
        .send({ phone: '9876543210' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isExisting).toBe(true);
      expect(res.body.data.phone).toBe('9876543210');
      // Verify no sensitive account/financial enumeration
      expect(res.body.data.userId).toBeUndefined();
      expect(res.body.data.wallet).toBeUndefined();
      expect(res.body.data.commission).toBeUndefined();
    });

    it('returns isExisting: false for new/unregistered mobile number', async () => {
      jest.spyOn(UserRepository.prototype, 'findByPhone').mockResolvedValueOnce(null);

      const res = await request(app)
        .post('/api/v1/auth/check-phone')
        .send({ phone: '9123456780' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isExisting).toBe(false);
      expect(res.body.data.phone).toBe('9123456780');
    });

    it('rejects invalid mobile number format with 400 ValidationError', async () => {
      const res = await request(app)
        .post('/api/v1/auth/check-phone')
        .send({ phone: '123' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    });
  });

  // ── 2. session endpoint ──────────────────────────────────────────
  describe('POST /api/v1/auth/session', () => {
    it('rejects request without Authorization header with 401', async () => {
      const res = await request(app).post('/api/v1/auth/session');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTH_REQUIRED);
    });

    it('rejects expired Firebase token with 401 TOKEN_EXPIRED', async () => {
      const res = await request(app)
        .post('/api/v1/auth/session')
        .set('Authorization', 'Bearer expired-token');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(ERROR_CODES.TOKEN_EXPIRED);
    });

    it('rejects revoked Firebase token with 401 TOKEN_REVOKED', async () => {
      const res = await request(app)
        .post('/api/v1/auth/session')
        .set('Authorization', 'Bearer revoked-token');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(ERROR_CODES.TOKEN_REVOKED);
    });

    it('returns registration-required state when valid Firebase user has no partner profile in DB', async () => {
      const res = await request(app)
        .post('/api/v1/auth/session')
        .set('Authorization', 'Bearer unregistered-firebase-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isRegistered).toBe(false);
      expect(res.body.data.user.authId).toBe('uid-new-partner');
      expect(res.body.data.message).toBe('Partner registration required');
    });

    it('returns full authoritative partner profile and session for registered partner', async () => {
      jest.spyOn(ShopRepository.prototype, 'findByPartnerId').mockResolvedValueOnce({
        shop_name: 'Apex Wheels & Rentals',
        shop_address: 'MP Nagar, Bhopal',
        city: 'Bhopal',
        operating_info: '07:00 AM - 11:00 PM',
      });

      const res = await request(app)
        .post('/api/v1/auth/session')
        .set('Authorization', 'Bearer valid-partner-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isRegistered).toBe(true);
      expect(res.body.data.user.id).toBe('user-123');
      expect(res.body.data.partner.id).toBe('partner-123');
      expect(res.body.data.partner.partnerStatus).toBe('ONLINE');
      expect(res.body.data.partner.kycStatus).toBe('VERIFIED');
      expect(res.body.data.partner.shopName).toBe('Apex Wheels & Rentals');
      expect(res.body.data.session.authenticated).toBe(true);
      // Ensure zero internal commission leakage
      expect(res.body.data.partner.commissionRate).toBeUndefined();
      expect(res.body.data.partner.commissionAmount).toBeUndefined();
    });

    it('rejects deactivated partner account with 403 Forbidden', async () => {
      const res = await request(app)
        .post('/api/v1/auth/session')
        .set('Authorization', 'Bearer deactivated-token');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(ERROR_CODES.ACCOUNT_DEACTIVATED);
    });
  });

  // ── 3. register endpoint ─────────────────────────────────────────
  describe('POST /api/v1/auth/register', () => {
    it('rejects mass-assignment attempts to inject server-controlled fields', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .set('Authorization', 'Bearer unregistered-firebase-token')
        .send({
          name: 'Attacker',
          shopName: 'Hack Hub',
          city: 'Bhopal',
          role: 'ADMIN',
          walletBalance: 99999,
          kycStatus: 'VERIFIED',
          commissionRate: 0,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
    });

    it('rejects registration with missing required fields', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .set('Authorization', 'Bearer unregistered-firebase-token')
        .send({
          name: 'Ramesh Verma',
          // missing shopName, city, landmark
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    });

    it('rejects registration when landmark is missing or empty or whitespace-only', async () => {
      const resMissing = await request(app)
        .post('/api/v1/auth/register')
        .set('Authorization', 'Bearer unregistered-firebase-token')
        .send({
          name: 'Ramesh Verma',
          shopName: 'Verma Wheels',
          city: 'Bhopal',
          shopAddress: 'Plot 12, Indrapuri',
        });

      expect(resMissing.status).toBe(400);
      expect(resMissing.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
      expect(resMissing.body.message).toMatch(/landmark/i);

      const resWhitespace = await request(app)
        .post('/api/v1/auth/register')
        .set('Authorization', 'Bearer unregistered-firebase-token')
        .send({
          name: 'Ramesh Verma',
          shopName: 'Verma Wheels',
          city: 'Bhopal',
          shopAddress: 'Plot 12, Indrapuri',
          landmark: '     ',
        });

      expect(resWhitespace.status).toBe(400);
      expect(resWhitespace.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
      expect(resWhitespace.body.message).toMatch(/landmark/i);
    });

    it('successfully registers first-time partner with atomic initial states', async () => {
      jest.spyOn(UserRepository.prototype, 'findByAuthId').mockResolvedValueOnce(null);
      jest.spyOn(UserRepository.prototype, 'findByPhone').mockResolvedValueOnce(null);

      // Mock pool transaction
      const transactionSpy = jest.spyOn(poolModule, 'transaction').mockImplementationOnce(async (cb) => {
        const mockClient = {
          query: jest.fn().mockResolvedValue({ rows: [{ id: 'new-consent-id' }] }),
        };
        return cb(mockClient);
      });

      jest.spyOn(UserRepository.prototype, 'createUser').mockResolvedValueOnce({
        id: 'new-u-id',
        auth_id: 'uid-new-partner',
        role: 'PARTNER',
        name: 'Ramesh Verma',
        phone: '9123456780',
        email: 'ramesh@gongo.in',
        is_active: true,
      });

      jest.spyOn(PartnerRepository.prototype, 'createPartner').mockResolvedValueOnce({
        id: 'new-p-id',
        user_id: 'new-u-id',
        partner_status: 'OFFLINE',
        kyc_status: 'PENDING',
        rating: 5.0,
        review_count: 0,
        registered_since: 'Sep 2026',
        profile_image_url: null,
      });

      jest.spyOn(ShopRepository.prototype, 'createShop').mockResolvedValueOnce({
        id: 'new-s-id',
        partner_id: 'new-p-id',
        shop_name: 'Verma Wheels & Rentals',
        shop_address: 'Indrapuri, Bhopal',
        city: 'Bhopal',
        operating_info: '08:00 AM - 10:00 PM (All Days)',
      });

      jest.spyOn(WalletRepository.prototype, 'createWallet').mockResolvedValueOnce({
        id: 'new-w-id',
        partner_id: 'new-p-id',
        available_balance: '0.00',
        pending_balance: '0.00',
      });

      const res = await request(app)
        .post('/api/v1/auth/register')
        .set('Authorization', 'Bearer unregistered-firebase-token')
        .send({
          name: 'Ramesh Verma',
          shopName: 'Verma Wheels & Rentals',
          city: 'Bhopal',
          shopAddress: 'Indrapuri, Bhopal',
          landmark: 'Near SBI Bank, opposite City Mall',
          phone: '9123456780',
          email: 'ramesh@gongo.in',
          termsAccepted: true,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isRegistered).toBe(true);
      expect(res.body.data.partner.partnerStatus).toBe('OFFLINE'); // Initial offline
      expect(res.body.data.partner.kycStatus).toBe('PENDING'); // Initial pending
      expect(res.body.data.partner.isNewPartner).toBe(true);
      expect(transactionSpy).toHaveBeenCalled();
    });

    it('rejects registration when termsAccepted is missing or false', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .set('Authorization', 'Bearer unregistered-firebase-token')
        .send({
          name: 'Ramesh Verma',
          shopName: 'Verma Wheels & Rentals',
          city: 'Bhopal',
          landmark: 'Near SBI Bank',
          phone: '9123456780',
          termsAccepted: false,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
      expect(res.body.message).toMatch(/Terms & Conditions/i);
    });

    it('rejects duplicate registration when authId already exists with 409 Conflict', async () => {
      jest.spyOn(UserRepository.prototype, 'findByAuthId').mockResolvedValueOnce({ id: 'existing-uid' });

      const res = await request(app)
        .post('/api/v1/auth/register')
        .set('Authorization', 'Bearer unregistered-firebase-token')
        .send({
          name: 'Ramesh Verma',
          shopName: 'Verma Wheels',
          city: 'Bhopal',
          landmark: 'Near DB Mall',
          phone: '9123456780',
          termsAccepted: true,
        });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(ERROR_CODES.CONFLICT);
    });
  });

  // ── 4. /auth/me endpoint ─────────────────────────────────────────
  describe('GET /api/v1/auth/me', () => {
    it('returns live database state for authenticated partner', async () => {
      jest.spyOn(ShopRepository.prototype, 'findByPartnerId').mockResolvedValueOnce({
        shop_name: 'Apex Wheels & Rentals',
        city: 'Bhopal',
      });

      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer valid-partner-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.partner.id).toBe('partner-123');
      expect(res.body.data.partner.kycStatus).toBe('VERIFIED');
    });

    it('denies access to non-PARTNER role (e.g. CUSTOMER) with 403 Forbidden', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer customer-token');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });

    it('forged partnerId in query or params does not override backend identity', async () => {
      jest.spyOn(ShopRepository.prototype, 'findByPartnerId').mockResolvedValueOnce({
        shop_name: 'Apex Wheels & Rentals',
        city: 'Bhopal',
      });

      const res = await request(app)
        .get('/api/v1/auth/me?partnerId=forged-partner-victim')
        .set('Authorization', 'Bearer valid-partner-token');

      expect(res.status).toBe(200);
      expect(res.body.data.partner.id).toBe('partner-123');
      expect(res.body.data.partner.id).not.toBe('forged-partner-victim');
    });
  });

  // ── 5. logout endpoint ───────────────────────────────────────────
  describe('POST /api/v1/auth/logout', () => {
    it('successfully calls Firebase revocation and returns 200', async () => {
      const res = await request(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', 'Bearer valid-partner-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.message).toBe('Logged out successfully');
      expect(mockAuth.revokeRefreshTokens).toHaveBeenCalledWith('uid-partner-1');
    });
  });
});
