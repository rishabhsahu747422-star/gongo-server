'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const ShopRepository = require('../../src/repositories/shop.repository');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Integration: Shop & Location API', () => {
  let app;
  let mockAuth;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    mockAuth = {
      verifyIdToken: jest.fn(async (token) => {
        if (token === 'partner-token') {
          return { uid: 'uid-partner-1', phone_number: '+919876543210' };
        }
        if (token === 'customer-token') {
          return { uid: 'uid-cust', phone_number: '+919999900000' };
        }
        const err = new Error('Invalid token');
        err.code = 'auth/invalid-id-token';
        throw err;
      }),
      revokeRefreshTokens: jest.fn().mockResolvedValue(true),
    };
    setMockFirebaseAuth(mockAuth);

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
          is_active: true,
          partner_status: 'OFFLINE',
          kyc_status: 'PENDING',
        };
      }
      if (idOrAuth === 'uid-cust') {
        return {
          id: 'cust-1',
          partnerId: null,
          role: 'CUSTOMER',
          is_active: true,
        };
      }
      return null;
    });

    jest.spyOn(ShopRepository.prototype, 'findByPartnerId').mockResolvedValue({
      id: 'shop-123',
      partner_id: 'partner-123',
      shop_name: 'Apex Wheels & Rentals',
      shop_address: 'Plot 42, MP Nagar Zone 1',
      city: 'Bhopal',
      latitude: '23.2599330',
      longitude: '77.4126150',
      operating_info: '08:00 AM - 10:00 PM (All Days)',
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    PartnerRepository.setMockPartnerResolver(null);
    jest.restoreAllMocks();
  });

  describe('GET /api/v1/partner/shop', () => {
    it('returns shop details and parsed GPS coordinates for authenticated partner', async () => {
      const res = await request(app)
        .get('/api/v1/partner/shop')
        .set('Authorization', 'Bearer partner-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('shop-123');
      expect(res.body.data.shopName).toBe('Apex Wheels & Rentals');
      expect(res.body.data.latitude).toBeCloseTo(23.259933, 4);
      expect(res.body.data.longitude).toBeCloseTo(77.412615, 4);
      expect(typeof res.body.data.latitude).toBe('number');
    });

    it('rejects unauthenticated request with 401', async () => {
      const res = await request(app).get('/api/v1/partner/shop');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTH_REQUIRED);
    });
  });

  describe('PATCH /api/v1/partner/shop', () => {
    it('updates shop details and valid coordinates', async () => {
      jest.spyOn(ShopRepository.prototype, 'updateShop').mockResolvedValue({
        id: 'shop-123',
        partner_id: 'partner-123',
        shop_name: 'Apex Wheels Hub',
        shop_address: 'Plot 50, Commercial Zone, MP Nagar',
        city: 'Bhopal',
        latitude: 23.2500,
        longitude: 77.4200,
        operating_info: '07:00 AM - 11:00 PM',
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const res = await request(app)
        .patch('/api/v1/partner/shop')
        .set('Authorization', 'Bearer partner-token')
        .send({
          shopName: 'Apex Wheels Hub',
          shopAddress: 'Plot 50, Commercial Zone, MP Nagar',
          city: 'Bhopal',
          latitude: 23.2500,
          longitude: 77.4200,
          operatingInfo: '07:00 AM - 11:00 PM',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.shopName).toBe('Apex Wheels Hub');
      expect(res.body.data.latitude).toBe(23.25);
    });

    it('rejects latitude outside -90 to +90 degrees with 400', async () => {
      const res = await request(app)
        .patch('/api/v1/partner/shop')
        .set('Authorization', 'Bearer partner-token')
        .send({
          latitude: 91.5,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('Latitude must be a valid number between -90 and 90');
    });

    it('rejects longitude outside -180 to +180 degrees with 400', async () => {
      const res = await request(app)
        .patch('/api/v1/partner/shop')
        .set('Authorization', 'Bearer partner-token')
        .send({
          longitude: -185.0,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('Longitude must be a valid number between -180 and 180');
    });

    it('rejects server-controlled fields in shop update', async () => {
      const res = await request(app)
        .patch('/api/v1/partner/shop')
        .set('Authorization', 'Bearer partner-token')
        .send({
          partnerId: 'attacker-partner-id',
          shopName: 'Hacked Shop',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
    });
  });
});
