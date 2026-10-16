'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const vehicleRepository = require('../../src/repositories/vehicle.repository');
const pricingRepository = require('../../src/repositories/pricing.repository');
const pool = require('../../src/db/pool');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Integration: Vehicle Pricing API', () => {
  let app;
  let mockAuth;

  const partner1Id = '11111111-1111-1111-1111-111111111111';
  const partner2Id = '22222222-2222-2222-2222-222222222222';
  const vehicle1Id = 'aaaa1111-1111-1111-1111-111111111111';

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();

    mockAuth = {
      verifyIdToken: jest.fn(async (token) => {
        if (token === 'partner-1-token') {
          return { uid: 'uid-partner-1', phone_number: '+919876543210' };
        }
        if (token === 'partner-2-token') {
          return { uid: 'uid-partner-2', phone_number: '+919876543211' };
        }
        const err = new Error('Invalid token');
        err.code = 'auth/invalid-id-token';
        throw err;
      }),
      revokeRefreshTokens: jest.fn().mockResolvedValue(true),
    };
    setMockFirebaseAuth(mockAuth);

    PartnerRepository.setMockPartnerResolver((idOrAuth) => {
      if (idOrAuth === 'uid-partner-1' || idOrAuth === partner1Id) {
        return {
          id: partner1Id,
          partnerId: partner1Id,
          userId: 'user-partner-1',
          auth_id: 'uid-partner-1',
          role: 'PARTNER',
          is_active: true,
          partner_status: 'ONLINE',
          kyc_status: 'VERIFIED',
        };
      }
      if (idOrAuth === 'uid-partner-2' || idOrAuth === partner2Id) {
        return {
          id: partner2Id,
          partnerId: partner2Id,
          userId: 'user-partner-2',
          auth_id: 'uid-partner-2',
          role: 'PARTNER',
          is_active: true,
          partner_status: 'ONLINE',
          kyc_status: 'VERIFIED',
        };
      }
      return null;
    });
  });

  // ── GET /api/v1/partner/vehicles/:vehicleId/pricing ─────────────────
  describe('GET /api/v1/partner/vehicles/:vehicleId/pricing', () => {
    it('returns 200 with vehicle pricing for owned vehicle', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
      });

      jest.spyOn(pricingRepository, 'findByVehicleId').mockResolvedValue({
        id: 'price-1',
        vehicle_id: vehicle1Id,
        price_per_hour: '140.00',
        price_per_4_hours: '500.00',
        price_per_day: '2200.00',
        security_deposit: '4000.00',
        extra_km_charge: '14.00',
        currency: 'INR',
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const res = await request(app)
        .get(`/api/v1/partner/vehicles/${vehicle1Id}/pricing`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.pricePerDay).toBe(2200);
      expect(res.body.data.pricePerHour).toBe(140);
      expect(res.body.data.currency).toBe('INR');
    });

    it('returns 200 with default zero pricing if no pricing record configured yet', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
      });
      jest.spyOn(pricingRepository, 'findByVehicleId').mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/v1/partner/vehicles/${vehicle1Id}/pricing`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.pricePerDay).toBe(0);
      expect(res.body.data.pricePerHour).toBe(0);
    });

    it('returns 404 when partner attempts to access another partner vehicle pricing (BOLA)', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/v1/partner/vehicles/${vehicle1Id}/pricing`)
        .set('Authorization', 'Bearer partner-2-token');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('returns 401 when unauthenticated', async () => {
      const res = await request(app).get(`/api/v1/partner/vehicles/${vehicle1Id}/pricing`);
      expect(res.status).toBe(401);
    });
  });

  // ── PUT /api/v1/partner/vehicles/:vehicleId/pricing ─────────────────
  describe('PUT /api/v1/partner/vehicles/:vehicleId/pricing', () => {
    const validPricingPayload = {
      pricePerHour: 140,
      pricePer4Hours: 500,
      pricePerDay: 2200,
      securityDeposit: 4000,
      extraKmCharge: 14,
    };

    it('updates pricing successfully and returns 200', async () => {
      const mockClient = {};
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb(mockClient));

      jest.spyOn(vehicleRepository, 'findByIdAndPartnerIdForUpdate').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        registration_number: 'MP 04 AB 1234',
        is_archived: false,
      });

      jest.spyOn(pricingRepository, 'findByVehicleId').mockResolvedValue(null);
      jest.spyOn(pricingRepository, 'upsertPricing').mockResolvedValue({
        id: 'price-1',
        vehicle_id: vehicle1Id,
        price_per_hour: 140,
        price_per_4_hours: 500,
        price_per_day: 2200,
        security_deposit: 4000,
        extra_km_charge: 14,
        currency: 'INR',
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      jest.spyOn(pricingRepository, 'createHistoryRecord').mockResolvedValue({});

      const res = await request(app)
        .put(`/api/v1/partner/vehicles/${vehicle1Id}/pricing`)
        .set('Authorization', 'Bearer partner-1-token')
        .send(validPricingPayload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.pricePerDay).toBe(2200);
      expect(res.body.data.pricePerHour).toBe(140);
    });

    it('auto-derives pricePerHour and pricePer4Hours when only pricePerDay is provided', async () => {
      const mockClient = {};
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb(mockClient));

      jest.spyOn(vehicleRepository, 'findByIdAndPartnerIdForUpdate').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        registration_number: 'MP 04 AB 1234',
        is_archived: false,
      });

      jest.spyOn(pricingRepository, 'findByVehicleId').mockResolvedValue(null);
      const upsertSpy = jest.spyOn(pricingRepository, 'upsertPricing').mockResolvedValue({
        id: 'price-1',
        vehicle_id: vehicle1Id,
        price_per_hour: 100,
        price_per_4_hours: 375,
        price_per_day: 1500,
        security_deposit: 3000,
        extra_km_charge: 0,
        currency: 'INR',
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      jest.spyOn(pricingRepository, 'createHistoryRecord').mockResolvedValue({});

      const res = await request(app)
        .put(`/api/v1/partner/vehicles/${vehicle1Id}/pricing`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          pricePerDay: 1500,
          securityDeposit: 3000,
        });

      expect(res.status).toBe(200);
      expect(upsertSpy).toHaveBeenCalledWith(
        vehicle1Id,
        expect.objectContaining({
          pricePerDay: 1500,
          pricePerHour: 100,
          pricePer4Hours: 375,
        }),
        mockClient,
      );
    });

    it('rejects mass-assignment attempts (e.g. injecting id or vehicle_id)', async () => {
      const res = await request(app)
        .put(`/api/v1/partner/vehicles/${vehicle1Id}/pricing`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          ...validPricingPayload,
          id: 'evil-id',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
    });

    it('rejects negative rates', async () => {
      const res = await request(app)
        .put(`/api/v1/partner/vehicles/${vehicle1Id}/pricing`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          pricePerDay: -100,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    });

    it('returns 409 Conflict when attempting to set pricing on an archived vehicle', async () => {
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));

      jest.spyOn(vehicleRepository, 'findByIdAndPartnerIdForUpdate').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        is_archived: true,
      });

      const res = await request(app)
        .put(`/api/v1/partner/vehicles/${vehicle1Id}/pricing`)
        .set('Authorization', 'Bearer partner-1-token')
        .send(validPricingPayload);

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
    });
  });

  // ── GET /api/v1/partner/vehicles/:vehicleId/pricing/history ──────────
  describe('GET /api/v1/partner/vehicles/:vehicleId/pricing/history', () => {
    it('returns 200 with pricing change history', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
      });

      jest.spyOn(pricingRepository, 'getPricingHistory').mockResolvedValue([
        {
          id: 'hist-1',
          vehicle_id: vehicle1Id,
          price_per_hour: '140.00',
          price_per_4_hours: '500.00',
          price_per_day: '2200.00',
          security_deposit: '4000.00',
          extra_km_charge: '14.00',
          valid_from: '2026-09-20T10:00:00Z',
          valid_to: null,
          created_at: '2026-09-20T10:00:00Z',
        },
      ]);

      const res = await request(app)
        .get(`/api/v1/partner/vehicles/${vehicle1Id}/pricing/history`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data[0].pricePerDay).toBe(2200);
      expect(res.body.data[0]).toHaveProperty('changedBy');
    });

    it('forwards validated limit/offset to the repository', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
      });
      const repoSpy = jest.spyOn(pricingRepository, 'getPricingHistory').mockResolvedValue([]);

      const res = await request(app)
        .get(`/api/v1/partner/vehicles/${vehicle1Id}/pricing/history?limit=20&offset=40`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(repoSpy).toHaveBeenCalledWith(vehicle1Id, { limit: 20, offset: 40 });
    });

    it.each([
      ['limit=0'],
      ['limit=101'],
      ['limit=abc'],
      ['offset=-1'],
      ['offset=1.5'],
    ])('returns 400 for invalid query %s', async (qs) => {
      const repoSpy = jest.spyOn(pricingRepository, 'getPricingHistory');

      const res = await request(app)
        .get(`/api/v1/partner/vehicles/${vehicle1Id}/pricing/history?${qs}`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(400);
      expect(repoSpy).not.toHaveBeenCalled();
    });

    it('returns 404 when vehicle does not belong to partner (BOLA)', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/v1/partner/vehicles/${vehicle1Id}/pricing/history`)
        .set('Authorization', 'Bearer partner-2-token');

      expect(res.status).toBe(404);
    });
  });
});
