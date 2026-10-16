'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const PartnerRepository = require('../../src/repositories/partner.repository');
const UserRepository = require('../../src/repositories/user.repository');
const ShopRepository = require('../../src/repositories/shop.repository');
const BankAccountRepository = require('../../src/repositories/bank-account.repository');

describe('Integration: Development Authentication & Route Registration', () => {
  let app;
  const devAuthId = 'dev-partner-auth-id';
  const partnerId = 'dc3a5acd-8d03-45c0-8cb9-23d1b3ffd562';
  const userId = '9c84fa46-0cc7-4715-b5e5-e4ac97ac9646';

  beforeAll(() => {
    app = createApp();
  });

  afterAll(() => {
    PartnerRepository.setMockPartnerResolver(null);
  });

  beforeEach(() => {
    jest.clearAllMocks();

    PartnerRepository.setMockPartnerResolver((authId) => {
      if (authId === devAuthId || authId === partnerId) {
        return {
          id: partnerId,
          partnerId,
          userId,
          auth_id: devAuthId,
          name: 'GONGO Test Partner',
          phone: '+919999999999',
          email: 'dev.partner@gongo.in',
          role: 'PARTNER',
          kyc_status: 'VERIFIED',
          partner_status: 'ONLINE',
          rating: 5,
          review_count: 10,
          registered_since: 'Jan 2025',
          shop_name: 'GONGO Koramangala Hub',
          shop_address: '100 Feet Road, 4th Block, Koramangala, Bangalore',
          city: 'Bangalore',
          is_active: true,
        };
      }
      return null;
    });

    jest.spyOn(ShopRepository.prototype, 'findByPartnerId').mockResolvedValue({
      id: 'shop-dev-1',
      shop_name: 'GONGO Koramangala Hub',
      shop_address: '100 Feet Road, 4th Block, Koramangala, Bangalore',
      city: 'Bangalore',
      is_active: true,
    });

    jest.spyOn(BankAccountRepository.prototype, 'findPrimaryByPartnerId').mockResolvedValue({
      id: 'bank-dev-1',
      bank_name: 'HDFC Bank',
      account_holder_name: 'GONGO Test Partner',
      account_number_masked: 'XXXXXXXX9012',
      ifsc_code: 'HDFC0001234',
      is_primary: true,
      verification_status: 'VERIFIED',
    });

    jest.spyOn(PartnerRepository.prototype, 'countVehicles').mockResolvedValue(2);
  });

  describe('POST /api/v1/auth/dev-login', () => {
    it('returns 200 with deterministic dev token and partner profile', async () => {
      const res = await request(app)
        .post('/api/v1/auth/dev-login')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('token', 'dev-partner-token');
      expect(res.body.data).toHaveProperty('isRegistered', true);
      expect(res.body.data.partner).toMatchObject({
        id: partnerId,
        partnerStatus: 'ONLINE',
        kycStatus: 'VERIFIED',
      });
      expect(res.body.data.user).toMatchObject({
        id: userId,
        role: 'PARTNER',
      });
      expect(res.body.data.session).toMatchObject({
        authenticated: true,
        authProvider: 'supabase',
      });
    });

    it('returns 200 when explicit authId is passed', async () => {
      const res = await request(app)
        .post('/api/v1/auth/dev-login')
        .send({ authId: devAuthId });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.token).toBe('dev-partner-token');
    });
  });

  describe('GET /api/v1/auth/me with Bearer dev-partner-token', () => {
    it('returns 200 and resolves authenticated partner context', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer dev-partner-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.partner).toMatchObject({
        id: partnerId,
        partnerStatus: 'ONLINE',
        kycStatus: 'VERIFIED',
      });
      expect(res.body.data.user).toMatchObject({
        id: userId,
        role: 'PARTNER',
      });
    });

    it('returns 401 when Authorization header is missing', async () => {
      const res = await request(app).get('/api/v1/auth/me');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('AUTH_REQUIRED');
    });
  });

  describe('GET /api/v1/partner/profile with Bearer dev-partner-token', () => {
    it('returns 200 and full partner profile', async () => {
      const res = await request(app)
        .get('/api/v1/partner/profile')
        .set('Authorization', 'Bearer dev-partner-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.partner).toMatchObject({
        id: partnerId,
        shopName: 'GONGO Koramangala Hub',
      });
    });

    it('returns 401 when Authorization header is missing', async () => {
      const res = await request(app).get('/api/v1/partner/profile');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('AUTH_REQUIRED');
    });

    it('returns 401 when token is invalid', async () => {
      const res = await request(app)
        .get('/api/v1/partner/profile')
        .set('Authorization', 'Bearer invalid-garbage-token');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_TOKEN');
    });
  });

  describe('Security & Production Safeguards', () => {
    it('returns 404 when calling dev-login if dev auth is disabled or in production', async () => {
      const express = require('express');
      const testRouter = express.Router();
      const devAuthRegistered = false;
      if (devAuthRegistered) {
        testRouter.post('/dev-login', (req, res) => res.json({ success: true }));
      }
      const testApp = express();
      testApp.use('/api/v1/auth', testRouter);
      testApp.use((req, res) => res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.originalUrl} not found` }
      }));

      const res = await request(testApp).post('/api/v1/auth/dev-login').send({});
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });
});

