'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const bookingRepository = require('../../src/repositories/booking.repository');
const vehicleRepository = require('../../src/repositories/vehicle.repository');
const pool = require('../../src/db/pool');
const auditService = require('../../src/services/audit.service');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Integration: Partner Booking Return & Completion API', () => {
  let app;
  let mockAuth;

  const partner1Id = '11111111-1111-4111-a111-111111111111';
  const partner2Id = '22222222-2222-4222-a222-222222222222';
  const booking1Id = '33333333-3333-4333-a333-333333333333';
  const vehicle1Id = '55555555-5555-4555-a555-555555555555';

  const mockActiveBooking = {
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
    booking_status: 'ACTIVE',
    payment_status: 'COMPLETED',
    pickup_location: 'Indiranagar Hub, Bangalore',
    created_at: '2026-09-21T08:00:00.000Z',
    updated_at: '2026-09-25T10:05:00.000Z',
    vehicle_brand: 'Royal Enfield',
    vehicle_model: 'Classic 350',
    vehicle_variant: 'Dark Stealth',
    registration_number: 'KA01AB1234',
    vehicle_category: 'Motorcycle',
    vehicle_fuel_type: 'Petrol',
    vehicle_transmission: 'Manual',
    vehicle_seats: 2,
    vehicle_cover_image_key: 'vehicles/images/cover-123.jpg',
    vehicle_rental_status: 'ACTIVE',
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
    price_per_hour: '120.00',
    currency: 'INR',
    handover_at: '2026-09-25T10:05:00.000Z',
    odometer_start: '12000.00',
    fuel_level_start: 'FULL',
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

    jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));
    jest.spyOn(bookingRepository, 'recordStatusHistory').mockResolvedValue({});
  });

  // ── POST /api/v1/partner/bookings/:bookingId/return ─────────────────────────
  describe('POST /api/v1/partner/bookings/:bookingId/return', () => {
    it('successfully completes return on-time (within grace period) and resets vehicle to IDLE', async () => {
      const now = new Date('2026-09-27T10:10:00.000Z'); // 10 minutes late -> Grace period
      jest.useFakeTimers({ now });

      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue({
        ...mockActiveBooking,
      });

      const mockReturnVerification = {
        id: 'ret-verif-001',
        booking_id: booking1Id,
        returned_at: now.toISOString(),
        odometer_end: 12250,
        fuel_level_end: 'FULL',
        late_minutes: 10,
        late_fee: '0.00',
        extra_km: '0.00',
        extra_km_fee: '0.00',
        total_distance: '250.00',
        return_status: 'ON_TIME',
        notes: 'Vehicle returned smoothly',
        photos: [],
        verified_by: 'user-partner-1',
      };

      jest.spyOn(bookingRepository, 'upsertReturnVerification').mockResolvedValue(
        mockReturnVerification,
      );
      jest.spyOn(bookingRepository, 'updatePricingSnapshotCharges').mockResolvedValue({});
      jest.spyOn(bookingRepository, 'updateBookingStatus').mockResolvedValue({});
      jest.spyOn(vehicleRepository, 'updateRentalStatus').mockResolvedValue({});
      jest.spyOn(auditService, 'logEvent').mockReturnValue({});

      const completedBookingRow = {
        ...mockActiveBooking,
        booking_status: 'COMPLETED',
        returned_at: now.toISOString(),
        return_status: 'ON_TIME',
        odometer_end: '12250.00',
        total_distance: '250.00',
        late_minutes: 10,
        return_late_fee: '0.00',
      };

      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerId').mockResolvedValue(
        completedBookingRow,
      );
      jest.spyOn(bookingRepository, 'findDamageReportsByBookingId').mockResolvedValue([]);

      const response = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/return`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          odometerEnd: 12250,
          fuelLevelEnd: 'FULL',
          notes: 'Vehicle returned smoothly',
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      const { data } = response.body;
      expect(data.booking.bookingStatus).toBe('COMPLETED');
      // Verify expected return time is preserved
      expect(data.booking.expectedReturnAt).toBe(mockActiveBooking.expected_return_at);
      expect(data.returnVerification.returnStatus).toBe('ON_TIME');
      expect(data.returnVerification.lateMinutes).toBe(10);
      expect(data.returnVerification.lateFee).toBe(0);
      expect(data.returnVerification.totalDistance).toBe(250);

      // Verify vehicle state transition to IDLE
      expect(vehicleRepository.updateRentalStatus).toHaveBeenCalledWith(
        vehicle1Id,
        'IDLE',
        expect.anything(),
      );

      // Verify audit event
      expect(auditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'BOOKING_RETURN_COMPLETED',
          entityType: 'BOOKING',
          entityId: booking1Id,
        }),
      );

      jest.useRealTimers();
    });

    it('calculates late fee accurately using historical snapshot rate beyond grace period', async () => {
      const now = new Date('2026-09-27T11:45:00.000Z'); // 105 minutes late -> 2 billable hours
      jest.useFakeTimers({ now });

      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue({
        ...mockActiveBooking,
        price_per_hour: '150.00', // Snapshot hourly rate
      });

      const mockReturnVerification = {
        id: 'ret-verif-002',
        booking_id: booking1Id,
        returned_at: now.toISOString(),
        odometer_end: 12100,
        fuel_level_end: '75%',
        late_minutes: 105,
        late_fee: '300.00', // 2 hours * 150 = 300
        extra_km: '0.00',
        extra_km_fee: '0.00',
        total_distance: '100.00',
        return_status: 'LATE',
        notes: 'Customer delayed in traffic',
        photos: [],
      };

      jest.spyOn(bookingRepository, 'upsertReturnVerification').mockResolvedValue(
        mockReturnVerification,
      );
      jest.spyOn(bookingRepository, 'updatePricingSnapshotCharges').mockResolvedValue({});
      jest.spyOn(bookingRepository, 'updateBookingStatus').mockResolvedValue({});
      jest.spyOn(vehicleRepository, 'updateRentalStatus').mockResolvedValue({});
      jest.spyOn(auditService, 'logEvent').mockReturnValue({});

      jest.spyOn(bookingRepository, 'findPaymentsByBookingId').mockResolvedValue([
        { id: 'pay-ot-1', payment_type: 'OVERTIME_CHARGE', amount: '300.00', status: 'PAID' },
      ]);
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerId').mockResolvedValue({
        ...mockActiveBooking,
        booking_status: 'COMPLETED',
        returned_at: now.toISOString(),
        return_status: 'LATE',
        return_late_fee: '300.00',
        late_minutes: 105,
      });
      jest.spyOn(bookingRepository, 'findDamageReportsByBookingId').mockResolvedValue([]);

      const response = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/return`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          odometerEnd: 12100,
          fuelLevelEnd: '75%',
          notes: 'Customer delayed in traffic',
        });

      expect(response.status).toBe(200);
      expect(response.body.data.returnVerification.returnStatus).toBe('LATE');
      expect(response.body.data.returnVerification.lateMinutes).toBe(105);
      expect(response.body.data.returnVerification.lateFee).toBe(300);

      expect(bookingRepository.updatePricingSnapshotCharges).toHaveBeenCalledWith(
        booking1Id,
        expect.objectContaining({
          lateFee: 300,
        }),
        expect.anything(),
      );

      jest.useRealTimers();
    });

    it('strictly uses booking pricing snapshot rate and ignores vehicle current pricing', async () => {
      const now = new Date('2026-09-27T11:00:00.000Z'); // 60 minutes late -> 1 billable hour
      jest.useFakeTimers({ now });

      // Historical snapshot rate = 120, even if current vehicle rate was changed to 500
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue({
        ...mockActiveBooking,
        price_per_hour: '120.00',
      });

      const mockReturnVerification = {
        id: 'ret-verif-hist',
        booking_id: booking1Id,
        returned_at: now.toISOString(),
        late_minutes: 60,
        late_fee: '120.00', // 1 hr * 120 = 120, NOT 500
        return_status: 'LATE',
      };

      jest.spyOn(bookingRepository, 'upsertReturnVerification').mockResolvedValue(
        mockReturnVerification,
      );
      jest.spyOn(bookingRepository, 'updatePricingSnapshotCharges').mockResolvedValue({});
      jest.spyOn(bookingRepository, 'updateBookingStatus').mockResolvedValue({});
      jest.spyOn(vehicleRepository, 'updateRentalStatus').mockResolvedValue({});
      jest.spyOn(auditService, 'logEvent').mockReturnValue({});

      jest.spyOn(bookingRepository, 'findPaymentsByBookingId').mockResolvedValue([
        { id: 'pay-ot-2', payment_type: 'OVERTIME_CHARGE', amount: '120.00', status: 'PAID' },
      ]);
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerId').mockResolvedValue({
        ...mockActiveBooking,
        booking_status: 'COMPLETED',
        returned_at: now.toISOString(),
        return_status: 'LATE',
        return_late_fee: '120.00',
        late_minutes: 60,
      });
      jest.spyOn(bookingRepository, 'findDamageReportsByBookingId').mockResolvedValue([]);

      const response = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/return`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          odometerEnd: 12100,
        });

      expect(response.status).toBe(200);
      expect(response.body.data.returnVerification.lateFee).toBe(120);

      // Verified charges updated with snapshot rate
      expect(bookingRepository.updatePricingSnapshotCharges).toHaveBeenCalledWith(
        booking1Id,
        expect.objectContaining({
          lateFee: 120,
        }),
        expect.anything(),
      );

      jest.useRealTimers();
    });

    it('allows vehicle return when overtime is unpaid and partner confirms collection (overtimeCollected: true)', async () => {
      const now = new Date('2026-09-27T11:45:00.000Z'); // 105 minutes late = ₹300 due
      jest.useFakeTimers({ now });

      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue({
        ...mockActiveBooking,
        price_per_hour: '150.00',
      });
      jest.spyOn(bookingRepository, 'findPaymentsByBookingId').mockResolvedValue([]); // Unpaid online

      const response = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/return`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          odometerEnd: 12100,
          fuelLevelEnd: '75%',
          overtimeCollected: true,
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Verify return verification saved with COLLECTED_BY_PARTNER
      expect(bookingRepository.upsertReturnVerification).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: booking1Id,
          lateMinutes: 105,
          lateFee: 300,
          returnStatus: 'LATE',
        }),
        expect.anything(),
      );

      const verificationCall = bookingRepository.upsertReturnVerification.mock.calls[0][0];
      const parsedNotes = JSON.parse(verificationCall.notes);
      expect(parsedNotes.overtime.overtimePaymentStatus).toBe('COLLECTED_BY_PARTNER');
      expect(parsedNotes.overtime.confirmedAmount).toBe(300);
      expect(parsedNotes.overtime.collectionDetails.status).toBe('COLLECTED_BY_PARTNER');
      expect(parsedNotes.overtime.collectionDetails.confirmedAmount).toBe(300);

      // Verify booking status transitioned to COMPLETED and vehicle to IDLE
      expect(bookingRepository.updateBookingStatus).toHaveBeenCalledWith(booking1Id, 'COMPLETED', expect.anything());
      expect(vehicleRepository.updateRentalStatus).toHaveBeenCalledWith(mockActiveBooking.vehicle_id, 'IDLE', expect.anything());

      // Verify status history recorded collection decision
      expect(bookingRepository.recordStatusHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: booking1Id,
          changeReason: expect.stringContaining('Overtime: ₹300 confirmed collected by partner'),
        }),
        expect.anything(),
      );

      jest.useRealTimers();
    });

    it('allows vehicle return when overtime is unpaid and partner waives collection (overtimeCollected: false)', async () => {
      const now = new Date('2026-09-27T11:45:00.000Z'); // 105 minutes late = ₹300 due
      jest.useFakeTimers({ now });

      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue({
        ...mockActiveBooking,
        price_per_hour: '150.00',
      });
      jest.spyOn(bookingRepository, 'findPaymentsByBookingId').mockResolvedValue([]); // Unpaid online

      const response = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/return`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          odometerEnd: 12100,
          fuelLevelEnd: '75%',
          overtimeCollected: false,
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Verify return verification saved with WAIVED_BY_PARTNER
      const verificationCall = bookingRepository.upsertReturnVerification.mock.calls[0][0];
      const parsedNotes = JSON.parse(verificationCall.notes);
      expect(parsedNotes.overtime.overtimePaymentStatus).toBe('WAIVED_BY_PARTNER');
      expect(parsedNotes.overtime.waivedAmount).toBe(300);
      expect(parsedNotes.overtime.collectionDetails.status).toBe('WAIVED_BY_PARTNER');

      // Verify status history recorded waiver decision
      expect(bookingRepository.recordStatusHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: booking1Id,
          changeReason: expect.stringContaining('Overtime: ₹300 waived by partner'),
        }),
        expect.anything(),
      );

      // Verify booking status transitioned to COMPLETED and vehicle to IDLE
      expect(bookingRepository.updateBookingStatus).toHaveBeenCalledWith(booking1Id, 'COMPLETED', expect.anything());
      expect(vehicleRepository.updateRentalStatus).toHaveBeenCalledWith(mockActiveBooking.vehicle_id, 'IDLE', expect.anything());

      jest.useRealTimers();
    });

    it('successfully completes return with online overtime payment already confirmed', async () => {
      const now = new Date('2026-09-27T11:45:00.000Z'); // 105 minutes late = ₹300 due
      jest.useFakeTimers({ now });

      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue({
        ...mockActiveBooking,
        price_per_hour: '150.00',
      });
      // Online payment already paid
      jest.spyOn(bookingRepository, 'findPaymentsByBookingId').mockResolvedValue([
        {
          id: 'pay-online-1',
          payment_type: 'OVERTIME_CHARGE',
          amount: '300.00',
          status: 'PAID',
          transaction_reference: 'TXN_ONLINE_PAID_123',
        },
      ]);

      const response = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/return`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          odometerEnd: 12100,
          fuelLevelEnd: '75%',
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      const verificationCall = bookingRepository.upsertReturnVerification.mock.calls[0][0];
      const parsedNotes = JSON.parse(verificationCall.notes);
      expect(parsedNotes.overtime.overtimePaymentStatus).toBe('PAID');
      expect(parsedNotes.overtime.paymentReference).toBe('TXN_ONLINE_PAID_123');
      expect(parsedNotes.overtime.collectionDetails.status).toBe('PAID_ONLINE');

      jest.useRealTimers();
    });

    it('rejects return when odometerEnd < odometerStart with 400 ValidationError', async () => {
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue({
        ...mockActiveBooking,
        odometer_start: '12000.00',
      });

      const response = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/return`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          odometerEnd: 11950, // Less than start!
          fuelLevelEnd: 'FULL',
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    });

    it('records damage report when included in return inspection payload', async () => {
      const now = new Date('2026-09-27T10:10:00.000Z'); // On time within grace period
      jest.useFakeTimers({ now });

      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue({
        ...mockActiveBooking,
      });

      jest.spyOn(bookingRepository, 'upsertReturnVerification').mockResolvedValue({
        id: 'ret-verif-dmg',
        booking_id: booking1Id,
        returned_at: now.toISOString(),
        return_status: 'ON_TIME',
        late_minutes: 0,
        late_fee: '0.00',
      });
      jest.spyOn(bookingRepository, 'createDamageReport').mockResolvedValue({
        id: 'dmg-rep-001',
        booking_id: booking1Id,
        vehicle_id: vehicle1Id,
      });
      jest.spyOn(bookingRepository, 'updatePricingSnapshotCharges').mockResolvedValue({});
      jest.spyOn(bookingRepository, 'updateBookingStatus').mockResolvedValue({});
      jest.spyOn(vehicleRepository, 'updateRentalStatus').mockResolvedValue({});
      jest.spyOn(auditService, 'logEvent').mockReturnValue({});

      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerId').mockResolvedValue({
        ...mockActiveBooking,
        booking_status: 'COMPLETED',
      });
      jest.spyOn(bookingRepository, 'findDamageReportsByBookingId').mockResolvedValue([
        {
          id: 'dmg-rep-001',
          damage_type: 'SCRATCH',
          description: 'Deep scratch on rear bumper',
          estimated_amount: '1500.00',
          approved_amount: null,
          status: 'REPORTED',
          photos: ['uploads/damages/scratch.jpg'],
          created_at: '2026-09-27T10:00:00.000Z',
        },
      ]);

      const response = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/return`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          odometerEnd: 12200,
          fuelLevelEnd: 'FULL',
          damageReport: {
            damageType: 'SCRATCH',
            description: 'Deep scratch on rear bumper',
            estimatedAmount: 1500,
            photos: ['uploads/damages/scratch.jpg'],
          },
        });

      expect(response.status).toBe(200);
      expect(bookingRepository.createDamageReport).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: booking1Id,
          vehicleId: vehicle1Id,
          damageType: 'SCRATCH',
          description: 'Deep scratch on rear bumper',
          estimatedAmount: 1500,
        }),
        expect.anything(),
      );

      expect(auditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'BOOKING_RETURN_COMPLETED',
          entityId: booking1Id,
        }),
      );

      expect(auditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DAMAGE_REPORT_CREATED',
          entityType: 'DAMAGE_REPORT',
        }),
      );

      jest.useRealTimers();
    });

    it('enforces idempotency on repeated return call when booking is already COMPLETED', async () => {
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue({
        ...mockActiveBooking,
        booking_status: 'COMPLETED',
      });

      const existingVerif = {
        id: 'ret-verif-existing',
        booking_id: booking1Id,
        returned_at: '2026-09-27T10:10:00.000Z',
        return_status: 'ON_TIME',
        late_minutes: 10,
        late_fee: '0.00',
        odometer_end: '12250.00',
        total_distance: '250.00',
      };

      jest.spyOn(bookingRepository, 'findReturnVerificationByBookingId').mockResolvedValue(
        existingVerif,
      );
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerId').mockResolvedValue({
        ...mockActiveBooking,
        booking_status: 'COMPLETED',
        returned_at: '2026-09-27T10:10:00.000Z',
      });
      jest.spyOn(bookingRepository, 'findDamageReportsByBookingId').mockResolvedValue([]);

      const response = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/return`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          odometerEnd: 12250,
          fuelLevelEnd: 'FULL',
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.booking.bookingStatus).toBe('COMPLETED');
    });

    it('returns 409 Conflict when attempting to return booking not in ACTIVE state', async () => {
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue({
        ...mockActiveBooking,
        booking_status: 'CONFIRMED',
      });

      const response = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/return`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          odometerEnd: 12250,
        });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe(ERROR_CODES.CONFLICT);
    });

    it('enforces BOLA by returning 404 when another partner attempts to return booking', async () => {
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue(null);

      const response = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/return`)
        .set('Authorization', 'Bearer partner-2-token')
        .send({
          odometerEnd: 12250,
        });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe(ERROR_CODES.NOT_FOUND);
    });

    it('rejects mass assignment attempt to inject status or return timing', async () => {
      const response = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/return`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          odometerEnd: 12250,
          status: 'COMPLETED',
          lateFee: 0,
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
    });
  });

  // ── GET /api/v1/partner/bookings/:bookingId/return ──────────────────────────
  describe('GET /api/v1/partner/bookings/:bookingId/return', () => {
    it('returns return verification details and summary for partner', async () => {
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerId').mockResolvedValue({
        ...mockActiveBooking,
        booking_status: 'COMPLETED',
      });
      jest.spyOn(bookingRepository, 'findReturnVerificationByBookingId').mockResolvedValue({
        id: 'ret-123',
        booking_id: booking1Id,
        returned_at: '2026-09-27T10:10:00.000Z',
        return_status: 'ON_TIME',
        odometer_end: '12250.00',
        fuel_level_end: 'FULL',
        late_minutes: 10,
        late_fee: '0.00',
        extra_km: '0.00',
        extra_km_fee: '0.00',
        total_distance: '250.00',
      });
      jest.spyOn(bookingRepository, 'findDamageReportsByBookingId').mockResolvedValue([]);

      const response = await request(app)
        .get(`/api/v1/partner/bookings/${booking1Id}/return`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.bookingId).toBe(booking1Id);
      expect(response.body.data.returnStatus).toBe('ON_TIME');
      expect(response.body.data.totalDistance).toBe(250);
      expect(response.body.data.settlementSummary).toBeDefined();
      expect(response.body.data.commission).toBeUndefined(); // Zero commission leakage
    });
  });

  // ── POST /api/v1/partner/bookings/:bookingId/damage ─────────────────────────
  describe('POST /api/v1/partner/bookings/:bookingId/damage', () => {
    it('creates standalone damage report successfully', async () => {
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue({
        ...mockActiveBooking,
      });
      jest.spyOn(bookingRepository, 'createDamageReport').mockResolvedValue({
        id: 'dmg-standalone-01',
        booking_id: booking1Id,
        vehicle_id: vehicle1Id,
        damage_type: 'DENT',
        description: 'Dent on door',
        estimated_amount: '2000.00',
        status: 'REPORTED',
        photos: [],
        created_at: '2026-09-27T11:00:00.000Z',
      });
      jest.spyOn(auditService, 'logEvent').mockReturnValue({});

      const response = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/damage`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          damageType: 'DENT',
          description: 'Dent on door from unexpected obstacle',
          estimatedAmount: 2000,
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.damageType).toBe('DENT');
      expect(response.body.data.status).toBe('REPORTED');
    });

    it('rejects damage reporting for another partner booking with 404', async () => {
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue(null);

      const response = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/damage`)
        .set('Authorization', 'Bearer partner-2-token')
        .send({
          damageType: 'SCRATCH',
          description: 'Scratch on panel',
        });

      expect(response.status).toBe(404);
    });
  });
});
