'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const UserRepository = require('../../src/repositories/user.repository');
const ShopRepository = require('../../src/repositories/shop.repository');
const poolModule = require('../../src/db/pool');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Integration: Partner Profile API', () => {
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
        if (token === 'partner-2-token') {
          return { uid: 'uid-partner-2', phone_number: '+919876543211', email: 'partner2@gongo.in' };
        }
        if (token === 'customer-token') {
          return { uid: 'uid-customer-1', phone_number: '+919999900000', email: 'cust@gongo.in' };
        }
        const err = new Error('Invalid token');
        err.code = 'auth/invalid-id-token';
        throw err;
      }),
      revokeRefreshTokens: jest.fn().mockResolvedValue(true),
    };
    setMockFirebaseAuth(mockAuth);

    // Setup Mock Partner Repository Resolver
    PartnerRepository.setMockPartnerResolver((idOrAuth) => {
      if (idOrAuth === 'uid-partner-1' || idOrAuth === 'partner-123') {
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
          partner_status: 'OFFLINE',
          kyc_status: 'PENDING',
          rating: 4.9,
          review_count: 42,
          registered_since: 'Nov 2024',
          profile_image_url: 'https://images.gongo.in/vikram.jpg',
        };
      }
      if (idOrAuth === 'uid-partner-2' || idOrAuth === 'partner-456') {
        return {
          id: 'partner-456',
          partnerId: 'partner-456',
          userId: 'user-456',
          auth_id: 'uid-partner-2',
          role: 'PARTNER',
          name: 'Partner Two',
          phone: '9876543211',
          email: 'partner2@gongo.in',
          is_active: true,
          partner_status: 'OFFLINE',
          kyc_status: 'PENDING',
          rating: 5.0,
          review_count: 0,
          registered_since: 'Dec 2024',
          profile_image_url: null,
        };
      }
      if (idOrAuth === 'uid-customer-1') {
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
      return null;
    });

    // Mock ShopRepository
    jest.spyOn(ShopRepository.prototype, 'findByPartnerId').mockImplementation(async (partnerId) => {
      if (partnerId === 'partner-123') {
        return {
          id: 'shop-123',
          partner_id: 'partner-123',
          shop_name: 'Apex Wheels & Rentals',
          shop_address: 'Plot 42, MP Nagar Zone 1',
          city: 'Bhopal',
          latitude: 23.2599,
          longitude: 77.4126,
          operating_info: '08:00 AM - 10:00 PM',
          is_active: true,
        };
      }
      return null;
    });

    // Mock Vehicle count
    jest.spyOn(PartnerRepository.prototype, 'countVehicles').mockResolvedValue(0);
  });

  afterEach(() => {
    PartnerRepository.setMockPartnerResolver(null);
    jest.restoreAllMocks();
  });

  describe('GET /api/v1/partner/profile', () => {
    it('rejects unauthenticated request with 401', async () => {
      const res = await request(app).get('/api/v1/partner/profile');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTH_REQUIRED);
    });

    it('rejects non-PARTNER role with 403 Forbidden', async () => {
      const res = await request(app)
        .get('/api/v1/partner/profile')
        .set('Authorization', 'Bearer customer-token');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });

    it('returns full frontend-compatible profile with derived completion flags', async () => {
      const res = await request(app)
        .get('/api/v1/partner/profile')
        .set('Authorization', 'Bearer valid-partner-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const { user, partner, completion } = res.body.data;
      expect(user.id).toBe('user-123');
      expect(user.name).toBe('Vikram Sharma');
      expect(user.phone).toBe('+91 9876543210');
      expect(user.role).toBe('PARTNER');

      expect(partner.id).toBe('partner-123');
      expect(partner.shopName).toBe('Apex Wheels & Rentals');
      expect(partner.city).toBe('Bhopal');
      expect(partner.partnerStatus).toBe('OFFLINE');
      expect(partner.kycStatus).toBe('PENDING');
      expect(partner.isNewPartner).toBe(true);

      expect(completion.isProfileComplete).toBe(true);
      expect(completion.isShopComplete).toBe(true);
      expect(completion.isKycComplete).toBe(false);

      // Financial isolation: verify commission and wallet internals are not returned
      expect(res.body.data.walletBalance).toBeUndefined();
      expect(res.body.data.commission).toBeUndefined();
    });

    it('forged partnerId query does not override backend identity', async () => {
      const res = await request(app)
        .get('/api/v1/partner/profile?partnerId=partner-456')
        .set('Authorization', 'Bearer valid-partner-token');

      expect(res.status).toBe(200);
      expect(res.body.data.partner.id).toBe('partner-123');
    });
  });

  describe('PATCH /api/v1/partner/profile', () => {
    it('successfully updates name, email, profile image, and shop address', async () => {
      jest.spyOn(poolModule, 'transaction').mockImplementation(async (callback) => {
        const mockClient = { query: jest.fn().mockResolvedValue({ rows: [] }) };
        return callback(mockClient);
      });

      jest.spyOn(UserRepository.prototype, 'updateUser').mockResolvedValue({});
      jest.spyOn(PartnerRepository.prototype, 'updatePartner').mockResolvedValue({});
      jest.spyOn(ShopRepository.prototype, 'updateShop').mockResolvedValue({});

      const res = await request(app)
        .patch('/api/v1/partner/profile')
        .set('Authorization', 'Bearer valid-partner-token')
        .send({
          name: 'Vikram S. Sharma',
          email: 'vikram.new@gongo.in',
          profileImage: 'https://images.gongo.in/new-avatar.jpg',
          shopAddress: 'Plot 43, MP Nagar Zone 1, Bhopal',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('rejects attempt to update phone number (phone immutability)', async () => {
      const res = await request(app)
        .patch('/api/v1/partner/profile')
        .set('Authorization', 'Bearer valid-partner-token')
        .send({
          name: 'Vikram Sharma',
          phone: '+919999911111',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('Phone is tied to authentication identity');
    });

    it('rejects mass-assignment attempts with MASS_ASSIGNMENT_VIOLATION', async () => {
      const payloads = [
        { kycStatus: 'VERIFIED' },
        { partnerStatus: 'ONLINE' },
        { rating: 5.0 },
        { reviewCount: 500 },
        { walletBalance: 99999 },
        { commission: 0 },
        { role: 'ADMIN' },
      ];

      await Promise.all(
        payloads.map(async (payload) => {
          const res = await request(app)
            .patch('/api/v1/partner/profile')
            .set('Authorization', 'Bearer valid-partner-token')
            .send(payload);

          expect(res.status).toBe(400);
          expect(res.body.success).toBe(false);
          expect(res.body.error.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
        }),
      );
    });

    it('rejects empty update body with 400 ValidationError', async () => {
      const res = await request(app)
        .patch('/api/v1/partner/profile')
        .set('Authorization', 'Bearer valid-partner-token')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });
});
