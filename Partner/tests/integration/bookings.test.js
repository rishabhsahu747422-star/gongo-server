'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const bookingRepository = require('../../src/repositories/booking.repository');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Integration: Partner Booking Operations API', () => {
  let app;
  let mockAuth;

  const partner1Id = '11111111-1111-4111-a111-111111111111';
  const partner2Id = '22222222-2222-4222-a222-222222222222';
  const booking1Id = '33333333-3333-4333-a333-333333333333';
  const vehicle1Id = '55555555-5555-4555-a555-555555555555';

  const mockBookingRowPartner1 = {
    id: booking1Id,
    booking_number: 'BK-2026-001',
    customer_id: 'cust-111',
    customer_name: 'Rahul Sharma',
    customer_phone: '+919876543210',
    partner_id: partner1Id,
    shop_id: 'shop-111',
    vehicle_id: vehicle1Id,
    start_at: '2026-09-25T10:00:00.000Z',
    expected_return_at: '2026-09-27T10:00:00.000Z',
    booking_status: 'CONFIRMED',
    payment_status: 'COMPLETED',
    pickup_location: 'Indiranagar Hub, Bangalore',
    created_at: '2026-09-21T08:00:00.000Z',
    updated_at: '2026-09-21T08:05:00.000Z',
    vehicle_brand: 'Royal Enfield',
    vehicle_model: 'Classic 350',
    vehicle_variant: 'Dark Stealth',
    registration_number: 'KA01AB1234',
    vehicle_category: 'Motorcycle',
    vehicle_fuel_type: 'Petrol',
    vehicle_transmission: 'Manual',
    vehicle_seats: 2,
    vehicle_cover_image_key: 'vehicles/images/cover-123.jpg',
    base_amount: '1600.00',
    rental_amount: '2000.00',
    security_deposit: '3000.00',
    extra_km_charge: '15.00',
    late_fee: '0.00',
    discount_amount: '200.00',
    taxes_amount: '324.00',
    total_customer_amount: '5124.00',
    currency: 'INR',
    handover_at: null,
  };

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
        if (token === 'customer-token') {
          return { uid: 'uid-customer', phone_number: '+919876543212' };
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
      if (idOrAuth === 'uid-customer') {
        return {
          id: 'cust-id',
          userId: 'user-cust',
          auth_id: 'uid-customer',
          role: 'CUSTOMER',
          is_active: true,
        };
      }
      return null;
    });
  });

  // ── Authentication & Authorization ─────────────────────────────────────────
  describe('Authentication & Authorization', () => {
    it('returns 401 when request has no Authorization header', async () => {
      const res = await request(app).get('/api/v1/partner/bookings');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTH_REQUIRED);
    });

    it('returns 401 when token is invalid', async () => {
      const res = await request(app)
        .get('/api/v1/partner/bookings')
        .set('Authorization', 'Bearer invalid-token');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 403 when authenticated user is not a PARTNER', async () => {
      const res = await request(app)
        .get('/api/v1/partner/bookings')
        .set('Authorization', 'Bearer customer-token');
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });
  });

  // ── GET /api/v1/partner/bookings ───────────────────────────────────────────
  describe('GET /api/v1/partner/bookings', () => {
    it('returns 200 with list of partner bookings and pagination', async () => {
      jest.spyOn(bookingRepository, 'findBookingsByPartnerId').mockResolvedValue([
        mockBookingRowPartner1,
      ]);
      jest.spyOn(bookingRepository, 'countBookingsByPartnerId').mockResolvedValue(1);

      const res = await request(app)
        .get('/api/v1/partner/bookings')
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.bookings)).toBe(true);
      expect(res.body.data.bookings).toHaveLength(1);

      const b = res.body.data.bookings[0];
      expect(b.id).toBe(booking1Id);
      expect(b.bookingNumber).toBe('BK-2026-001');
      expect(b.status).toBe('UPCOMING');
      expect(b.bookingStatus).toBe('CONFIRMED');
      expect(b.vehicleName).toBe('Royal Enfield Classic 350 Dark Stealth');
      expect(b.registrationNumber).toBe('KA01AB1234');
      expect(b.vehicleImage).toBe('vehicles/images/cover-123.jpg');
      expect(b.bookingAmount).toBe(2000);
      expect(b.securityDeposit).toBe(3000);
      expect(b.customerName).toBe('Rahul Sharma');
      expect(res.body.data.pagination).toEqual({
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });

      // Crucial: Zero commission leakage
      expect(b.pricing).toBeDefined();
      expect(b.pricing.commissionAmount).toBeUndefined();
      expect(b.pricing.commissionRate).toBeUndefined();
      expect(b.commissionAmount).toBeUndefined();
      expect(b.commission).toBeUndefined();
    });

    it('passes query filters (tab, search, page, limit) to repository correctly', async () => {
      jest.spyOn(bookingRepository, 'findBookingsByPartnerId').mockResolvedValue([]);
      jest.spyOn(bookingRepository, 'countBookingsByPartnerId').mockResolvedValue(0);

      const res = await request(app)
        .get('/api/v1/partner/bookings?tab=Active&search=KA01&page=2&limit=10')
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(bookingRepository.findBookingsByPartnerId).toHaveBeenCalledWith(
        partner1Id,
        expect.objectContaining({
          tab: 'Active',
          search: 'KA01',
          page: 2,
          limit: 10,
          offset: 10,
        }),
      );
    });

    it('returns 400 when invalid query parameters are supplied', async () => {
      const res = await request(app)
        .get('/api/v1/partner/bookings?tab=InvalidTab')
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    });
  });

  // ── GET /api/v1/partner/bookings/:bookingId ────────────────────────────────
  describe('GET /api/v1/partner/bookings/:bookingId', () => {
    it('returns 200 with booking details for owned vehicle', async () => {
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerId').mockResolvedValue(
        mockBookingRowPartner1,
      );

      const res = await request(app)
        .get(`/api/v1/partner/bookings/${booking1Id}`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(booking1Id);
      expect(res.body.data.customerPhone).toBe('+919876543210');
      expect(res.body.data.pickupLocation).toBe('Indiranagar Hub, Bangalore');
      expect(res.body.data.pricing.totalCustomerAmount).toBe(5124);

      // Verify no commission leakage
      expect(res.body.data.pricing.commissionAmount).toBeUndefined();
      expect(res.body.data.commission).toBeUndefined();
    });

    it('returns 404 when partner attempts to view another partner booking (Strict BOLA)', async () => {
      // Repository returns null because b.partner_id != partner2Id
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerId').mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/v1/partner/bookings/${booking1Id}`)
        .set('Authorization', 'Bearer partner-2-token');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.NOT_FOUND);
      expect(bookingRepository.findBookingByIdAndPartnerId).toHaveBeenCalledWith(
        booking1Id,
        partner2Id,
      );
    });

    it('returns 400 when bookingId is not a valid UUID', async () => {
      const res = await request(app)
        .get('/api/v1/partner/bookings/not-a-valid-uuid')
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    });
  });

  // ── HARD LOCK: Absence of Partner Accept / Reject / Confirm APIs ────────────
  describe('Hard Lock: No Partner Accept / Reject / Lifecycle Mutation APIs', () => {
    it('returns 404 for POST /api/v1/partner/bookings/:bookingId/accept', async () => {
      const res = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/accept`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({});

      expect(res.status).toBe(404);
    });

    it('returns 404 for POST /api/v1/partner/bookings/:bookingId/reject', async () => {
      const res = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/reject`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({});

      expect(res.status).toBe(404);
    });

    it('returns 404 for POST /api/v1/partner/bookings/:bookingId/confirm', async () => {
      const res = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/confirm`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({});

      expect(res.status).toBe(404);
    });

    it('returns 404 for PATCH /api/v1/partner/bookings/:bookingId', async () => {
      const res = await request(app)
        .patch(`/api/v1/partner/bookings/${booking1Id}`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({ status: 'CONFIRMED' });

      expect(res.status).toBe(404);
    });

    it('returns 404 for PUT /api/v1/partner/bookings/:bookingId', async () => {
      const res = await request(app)
        .put(`/api/v1/partner/bookings/${booking1Id}`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({ status: 'CONFIRMED' });

      expect(res.status).toBe(404);
    });

    it('returns 404 for POST /api/v1/partner/bookings (Partner cannot create bookings)', async () => {
      const res = await request(app)
        .post('/api/v1/partner/bookings')
        .set('Authorization', 'Bearer partner-1-token')
        .send({ vehicleId: vehicle1Id });

      expect(res.status).toBe(404);
    });
  });
});
