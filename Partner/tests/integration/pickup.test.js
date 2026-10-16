'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const bookingRepository = require('../../src/repositories/booking.repository');
const vehicleRepository = require('../../src/repositories/vehicle.repository');
const otpProvider = require('../../src/providers/otp.provider');
const smsProvider = require('../../src/providers/sms.provider');
const pool = require('../../src/db/pool');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Integration: Pickup & Active Rental Lifecycle API', () => {
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
    start_at: '2029-09-25T10:00:00.000Z',
    expected_return_at: '2029-09-27T10:00:00.000Z',
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
    vehicle_rental_status: 'BOOKED',
    vehicle_manual_status: 'ONLINE',
    vehicle_is_archived: false,
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
      const res = await request(app).post(`/api/v1/partner/bookings/${booking1Id}/pickup/otp`);
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTH_REQUIRED);
    });

    it('returns 403 when authenticated user is not a PARTNER', async () => {
      const res = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/pickup/otp`)
        .set('Authorization', 'Bearer customer-token');
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });
  });

  // ── BOLA Ownership Enforcement ─────────────────────────────────────────────
  describe('BOLA Ownership Enforcement', () => {
    it('returns 404 when partner attempts to request OTP for another partner booking', async () => {
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerId').mockResolvedValue(null);

      const res = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/pickup/otp`)
        .set('Authorization', 'Bearer partner-2-token');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.NOT_FOUND);
    });

    it('returns 404 when partner attempts to verify OTP for another partner booking', async () => {
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue(null);

      const res = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/pickup/verify`)
        .set('Authorization', 'Bearer partner-2-token')
        .send({ otp: '4829' });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.NOT_FOUND);
    });
  });

  // ── POST /api/v1/partner/bookings/:bookingId/pickup/otp ─────────────────────
  describe('POST /api/v1/partner/bookings/:bookingId/pickup/otp', () => {
    it('successfully dispatches OTP to customer without leaking raw OTP', async () => {
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerId').mockResolvedValue(
        mockBookingRowPartner1,
      );
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));
      jest.spyOn(bookingRepository, 'upsertPickupVerification').mockResolvedValue({});
      jest.spyOn(otpProvider, 'storeOtpState').mockResolvedValue();
      jest.spyOn(smsProvider, 'sendPickupOtp').mockResolvedValue({ success: true });

      const res = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/pickup/otp`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.message).toBe('Pickup OTP sent to customer successfully');
      expect(res.body.data.otp).toBeUndefined();
    });
  });

  // ── POST /api/v1/partner/bookings/:bookingId/pickup/verify ──────────────────
  describe('POST /api/v1/partner/bookings/:bookingId/pickup/verify', () => {
    it('successfully verifies OTP, transitions booking to ACTIVE, and returns 200', async () => {
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue(
        mockBookingRowPartner1,
      );
      jest.spyOn(bookingRepository, 'findConflictingActiveBooking').mockResolvedValue(null);
      jest.spyOn(otpProvider, 'getAttempts').mockResolvedValue(0);

      const salt = otpProvider.generateSalt();
      const otpHash = otpProvider.hashOtp('4829', salt);
      jest.spyOn(otpProvider, 'getOtpState').mockResolvedValue({ otpHash, salt });
      jest.spyOn(otpProvider, 'clearOtpState').mockResolvedValue();

      jest.spyOn(bookingRepository, 'upsertPickupVerification').mockResolvedValue({
        id: 'verif-1',
        verified_at: '2026-09-25T10:05:00.000Z',
      });
      jest.spyOn(bookingRepository, 'updateBookingStatus').mockResolvedValue({});
      jest.spyOn(vehicleRepository, 'updateRentalStatus').mockResolvedValue({});

      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerId').mockResolvedValue({
        ...mockBookingRowPartner1,
        booking_status: 'ACTIVE',
        handover_at: '2026-09-25T10:05:00.000Z',
      });

      const res = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/pickup/verify`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          otp: '4829',
          odometerStart: 12500,
          fuelLevelStart: 'FULL',
          depositCollected: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(booking1Id);
      expect(res.body.data.status).toBe('ACTIVE');
      expect(res.body.data.bookingStatus).toBe('ACTIVE');
      expect(res.body.data.handoverAt).toBe('2026-09-25T10:05:00.000Z');

      // Zero commission leakage
      expect(res.body.data.pricing).toBeDefined();
      expect(res.body.data.pricing.commissionAmount).toBeUndefined();
      expect(res.body.data.commission).toBeUndefined();
    });

    it('rejects invalid OTP with 400 VALIDATION_ERROR', async () => {
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue(
        mockBookingRowPartner1,
      );
      jest.spyOn(bookingRepository, 'findConflictingActiveBooking').mockResolvedValue(null);
      jest.spyOn(otpProvider, 'getAttempts').mockResolvedValue(0);

      const salt = otpProvider.generateSalt();
      const otpHash = otpProvider.hashOtp('4829', salt);
      jest.spyOn(otpProvider, 'getOtpState').mockResolvedValue({ otpHash, salt });
      jest.spyOn(otpProvider, 'incrementAttempts').mockResolvedValue(1);

      const res = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/pickup/verify`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({ otp: '0000' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
      expect(res.body.error.message).toContain('Invalid OTP');
    });

    it('rejects attempt to inject server-controlled fields with MASS_ASSIGNMENT_VIOLATION', async () => {
      const res = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/pickup/verify`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          otp: '4829',
          status: 'ACTIVE',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
    });

    it('rejects handover when security deposit is required, unpaid, and unconfirmed with 400 VALIDATION_ERROR', async () => {
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue({
        ...mockBookingRowPartner1,
        payment_status: 'PENDING',
        security_deposit: '3000.00',
      });
      jest.spyOn(bookingRepository, 'findConflictingActiveBooking').mockResolvedValue(null);
      jest.spyOn(otpProvider, 'getAttempts').mockResolvedValue(0);

      const salt = otpProvider.generateSalt();
      const otpHash = otpProvider.hashOtp('4829', salt);
      jest.spyOn(otpProvider, 'getOtpState').mockResolvedValue({ otpHash, salt });

      const res = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/pickup/verify`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          otp: '4829',
          odometerStart: 12500,
          fuelLevelStart: 'FULL',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
      expect(res.body.error.message).toContain('Security deposit must be collected');
    });

    it('allows handover when depositCollected is true even if advance payment was pending', async () => {
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue({
        ...mockBookingRowPartner1,
        payment_status: 'PENDING',
        security_deposit: '3000.00',
      });
      jest.spyOn(bookingRepository, 'findConflictingActiveBooking').mockResolvedValue(null);
      jest.spyOn(otpProvider, 'getAttempts').mockResolvedValue(0);

      const salt = otpProvider.generateSalt();
      const otpHash = otpProvider.hashOtp('4829', salt);
      jest.spyOn(otpProvider, 'getOtpState').mockResolvedValue({ otpHash, salt });
      jest.spyOn(otpProvider, 'clearOtpState').mockResolvedValue();

      jest.spyOn(bookingRepository, 'upsertPickupVerification').mockResolvedValue({
        id: 'verif-1',
        verified_at: '2026-09-25T10:05:00.000Z',
      });
      jest.spyOn(bookingRepository, 'updateBookingStatus').mockResolvedValue({});
      jest.spyOn(vehicleRepository, 'updateRentalStatus').mockResolvedValue({});

      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerId').mockResolvedValue({
        ...mockBookingRowPartner1,
        booking_status: 'ACTIVE',
        handover_at: '2026-09-25T10:05:00.000Z',
      });

      const res = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/pickup/verify`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          otp: '4829',
          depositCollected: true,
          odometerStart: 12500,
          fuelLevelStart: 'FULL',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('ACTIVE');
    });

    it('allows handover without deposit check when securityDeposit is 0', async () => {
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue({
        ...mockBookingRowPartner1,
        payment_status: 'PENDING',
        security_deposit: '0.00',
      });
      jest.spyOn(bookingRepository, 'findConflictingActiveBooking').mockResolvedValue(null);
      jest.spyOn(otpProvider, 'getAttempts').mockResolvedValue(0);

      const salt = otpProvider.generateSalt();
      const otpHash = otpProvider.hashOtp('4829', salt);
      jest.spyOn(otpProvider, 'getOtpState').mockResolvedValue({ otpHash, salt });
      jest.spyOn(otpProvider, 'clearOtpState').mockResolvedValue();

      jest.spyOn(bookingRepository, 'upsertPickupVerification').mockResolvedValue({
        id: 'verif-1',
        verified_at: '2026-09-25T10:05:00.000Z',
      });
      jest.spyOn(bookingRepository, 'updateBookingStatus').mockResolvedValue({});
      jest.spyOn(vehicleRepository, 'updateRentalStatus').mockResolvedValue({});

      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerId').mockResolvedValue({
        ...mockBookingRowPartner1,
        security_deposit: '0.00',
        booking_status: 'ACTIVE',
        handover_at: '2026-09-25T10:05:00.000Z',
      });

      const res = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/pickup/verify`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          otp: '4829',
          odometerStart: 12500,
          fuelLevelStart: 'FULL',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.securityDeposit).toBe(0);
      expect(res.body.data.depositStatus).toBeNull();
    });
  });

  // ── HARD LOCK: Absence of Partner Accept / Reject APIs ──────────────────────
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
        .send({ status: 'ACTIVE' });

      expect(res.status).toBe(404);
    });
  });
});
