'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const bookingRepository = require('../../src/repositories/booking.repository');
const paymentRepository = require('../../src/repositories/payment.repository');
const { PAYMENT_STATUS, PAYMENT_TYPE, SETTLEMENT_STATUS } = require('../../src/constants/payment');

describe('Integration: Partner Post-Rental Settlement & Payments Read APIs', () => {
  let app;
  let mockAuth;

  const partner1Id = '11111111-1111-4111-a111-111111111111';
  const partner2Id = '22222222-2222-4222-a222-222222222222';
  const booking1Id = '33333333-3333-4333-a333-333333333333';
  const vehicle1Id = '55555555-5555-4555-a555-555555555555';

  const mockCompletedBooking = {
    id: booking1Id,
    booking_number: 'BK-2026-RET-01',
    customer_id: 'cust-111',
    customer_name: 'Rahul Sharma',
    customer_phone: '+919876543210',
    partner_id: partner1Id,
    shop_id: 'shop-111',
    vehicle_id: vehicle1Id,
    start_at: '2026-09-25T10:00:00.000Z',
    expected_return_at: '2026-09-27T10:00:00.000Z',
    booking_status: 'COMPLETED',
    payment_status: 'COMPLETED',
    registration_number: 'KA01AB1234',
    currency: 'INR',
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

  afterAll(() => {
    PartnerRepository.setMockPartnerResolver(null);
  });

  describe('GET /api/v1/partner/bookings/:bookingId/settlement', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(app).get(`/api/v1/partner/bookings/${booking1Id}/settlement`);
      expect(res.status).toBe(401);
    });

    it('enforces BOLA isolation: returns 404 when Partner 2 attempts to view Partner 1 booking', async () => {
      jest.spyOn(bookingRepository, 'findPartnerBookingById').mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/v1/partner/bookings/${booking1Id}/settlement`)
        .set('Authorization', 'Bearer partner-2-token');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('BOOKING_NOT_FOUND');
    });

    it('returns accurate return settlement breakdown for on-time return with no fees', async () => {
      jest.spyOn(bookingRepository, 'findPartnerBookingById').mockResolvedValue(mockCompletedBooking);
      jest.spyOn(bookingRepository, 'findReturnVerificationByBookingId').mockResolvedValue({
        returned_at: '2026-09-27T10:00:00.000Z',
        odometer_end: '12500.00',
        late_minutes: 0,
        late_fee: '0.00',
        extra_km: '0.00',
        extra_km_fee: '0.00',
        return_status: 'ON_TIME',
      });
      jest.spyOn(bookingRepository, 'findDamageReportsByBookingId').mockResolvedValue([]);
      jest.spyOn(paymentRepository, 'findLatestByBookingAndType').mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/v1/partner/bookings/${booking1Id}/settlement`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.settlementStatus).toBe(SETTLEMENT_STATUS.NO_CHARGE);
      expect(res.body.data.charges.totalSettlementPayable).toBe(0);
      expect(res.body.data.returnVerification.returnStatus).toBe('ON_TIME');
    });

    it('calculates totalSettlementPayable from late_fee + extra_km_fee and excludes damage estimates', async () => {
      jest.spyOn(bookingRepository, 'findPartnerBookingById').mockResolvedValue(mockCompletedBooking);
      jest.spyOn(bookingRepository, 'findReturnVerificationByBookingId').mockResolvedValue({
        returned_at: '2026-09-27T12:00:00.000Z',
        odometer_end: '12600.00',
        late_minutes: 105,
        late_fee: '240.00',
        extra_km: '30.00',
        extra_km_fee: '450.00',
        return_status: 'LATE',
      });
      jest.spyOn(bookingRepository, 'findDamageReportsByBookingId').mockResolvedValue([
        {
          id: 'dmg-999',
          damage_type: 'DENT',
          description: 'Side panel dent',
          estimated_amount: '3500.00',
          status: 'REPORTED',
        },
      ]);
      jest.spyOn(paymentRepository, 'findLatestByBookingAndType').mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/v1/partner/bookings/${booking1Id}/settlement`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // late_fee (240) + extra_km_fee (450) = 690. Damage estimate 3500 MUST NOT be added!
      expect(res.body.data.charges.lateFee).toBe(240.00);
      expect(res.body.data.charges.extraKmFee).toBe(450.00);
      expect(res.body.data.charges.approvedDamageFee).toBe(0.00);
      expect(res.body.data.charges.totalSettlementPayable).toBe(690.00);
      expect(res.body.data.settlementStatus).toBe(SETTLEMENT_STATUS.UNPAID);

      // Verify damage report is marked as deferred approval
      expect(res.body.data.damageReports).toHaveLength(1);
      expect(res.body.data.damageReports[0].action).toBe('DEFERRED_APPROVAL');
      expect(res.body.data.damageReports[0].estimatedAmount).toBe(3500.00);
    });

    it('returns PAID when post-rental settlement payment is SUCCESS', async () => {
      jest.spyOn(bookingRepository, 'findPartnerBookingById').mockResolvedValue(mockCompletedBooking);
      jest.spyOn(bookingRepository, 'findReturnVerificationByBookingId').mockResolvedValue({
        returned_at: '2026-09-27T12:00:00.000Z',
        late_minutes: 60,
        late_fee: '200.00',
        extra_km: '0.00',
        extra_km_fee: '0.00',
        return_status: 'LATE',
      });
      jest.spyOn(bookingRepository, 'findDamageReportsByBookingId').mockResolvedValue([]);
      jest.spyOn(paymentRepository, 'findLatestByBookingAndType').mockResolvedValue({
        id: 'pay-settled-1',
        payment_type: PAYMENT_TYPE.POST_RENTAL_SETTLEMENT,
        provider: 'CASHFREE',
        provider_order_id: 'cf_settle_01',
        amount: '200.00',
        currency: 'INR',
        status: PAYMENT_STATUS.SUCCESS,
        created_at: '2026-09-27T12:15:00.000Z',
      });

      const res = await request(app)
        .get(`/api/v1/partner/bookings/${booking1Id}/settlement`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(res.body.data.settlementStatus).toBe(SETTLEMENT_STATUS.PAID);
      expect(res.body.data.payment.status).toBe(PAYMENT_STATUS.SUCCESS);
      expect(res.body.data.payment.amount).toBe(200.00);
    });
  });

  describe('GET /api/v1/partner/bookings/:bookingId/payments', () => {
    it('returns 404 for unauthorized BOLA cross-access', async () => {
      jest.spyOn(bookingRepository, 'findPartnerBookingById').mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/v1/partner/bookings/${booking1Id}/payments`)
        .set('Authorization', 'Bearer partner-2-token');

      expect(res.status).toBe(404);
    });

    it('returns chronological payments array for partner booking', async () => {
      jest.spyOn(bookingRepository, 'findPartnerBookingById').mockResolvedValue(mockCompletedBooking);
      jest.spyOn(paymentRepository, 'findAllByBookingId').mockResolvedValue([
        {
          id: 'pay-advance',
          payment_type: PAYMENT_TYPE.BOOKING_ADVANCE,
          provider: 'CASHFREE',
          provider_order_id: 'cf_adv_001',
          provider_payment_id: 'cf_pay_adv_999',
          amount: '5124.00',
          currency: 'INR',
          status: PAYMENT_STATUS.SUCCESS,
          created_at: '2026-09-21T08:05:00.000Z',
          updated_at: '2026-09-21T08:06:00.000Z',
        },
        {
          id: 'pay-settlement',
          payment_type: PAYMENT_TYPE.POST_RENTAL_SETTLEMENT,
          provider: 'CASHFREE',
          provider_order_id: 'cf_set_002',
          provider_payment_id: 'cf_pay_set_888',
          amount: '200.00',
          currency: 'INR',
          status: PAYMENT_STATUS.SUCCESS,
          created_at: '2026-09-27T12:15:00.000Z',
          updated_at: '2026-09-27T12:16:00.000Z',
        },
      ]);

      const res = await request(app)
        .get(`/api/v1/partner/bookings/${booking1Id}/payments`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.totalPayments).toBe(2);
      expect(res.body.data.payments[0].paymentType).toBe(PAYMENT_TYPE.BOOKING_ADVANCE);
      expect(res.body.data.payments[0].amount).toBe(5124.00);
      expect(res.body.data.payments[1].paymentType).toBe(PAYMENT_TYPE.POST_RENTAL_SETTLEMENT);
      expect(res.body.data.payments[1].amount).toBe(200.00);
    });
  });
});
