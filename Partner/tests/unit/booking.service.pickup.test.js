'use strict';

const bookingService = require('../../src/services/booking.service');
const bookingRepository = require('../../src/repositories/booking.repository');
const vehicleRepository = require('../../src/repositories/vehicle.repository');
const otpProvider = require('../../src/providers/otp.provider');
const smsProvider = require('../../src/providers/sms.provider');
const auditService = require('../../src/services/audit.service');
const pool = require('../../src/db/pool');
const { NotFoundError, ConflictError, ValidationError } = require('../../src/errors');

describe('Unit: BookingService Pickup Operations', () => {
  const partnerId = '11111111-1111-4111-a111-111111111111';
  const userId = 'user-partner-1';
  const bookingId = '22222222-2222-4222-a222-222222222222';
  const vehicleId = '33333333-3333-4333-a333-333333333333';

  const mockBookingRow = {
    id: bookingId,
    booking_number: 'BK-70492',
    customer_id: 'cust-101',
    customer_name: 'Amit Verma',
    customer_phone: '+919876543210',
    partner_id: partnerId,
    shop_id: 'shop-101',
    vehicle_id: vehicleId,
    start_at: new Date(Date.now() - 3600000).toISOString(),
    expected_return_at: new Date(Date.now() + 86400000).toISOString(),
    booking_status: 'CONFIRMED',
    payment_status: 'COMPLETED',
    pickup_location: 'Indiranagar Hub, Bangalore',
    created_at: '2026-09-21T08:00:00.000Z',
    updated_at: '2026-09-21T08:05:00.000Z',
    vehicle_brand: 'Toyota',
    vehicle_model: 'Innova Crysta',
    vehicle_variant: 'ZX',
    registration_number: 'KA03HA5678',
    vehicle_category: 'Car',
    vehicle_fuel_type: 'Diesel',
    vehicle_transmission: 'Automatic',
    vehicle_seats: 7,
    vehicle_cover_image_key: 'vehicles/images/innova.jpg',
    vehicle_rental_status: 'BOOKED',
    vehicle_manual_status: 'ONLINE',
    vehicle_is_archived: false,
    base_amount: '3500.00',
    rental_amount: '4000.00',
    security_deposit: '5000.00',
    extra_km_charge: '18.00',
    late_fee: '0.00',
    discount_amount: '0.00',
    taxes_amount: '720.00',
    total_customer_amount: '9720.00',
    currency: 'INR',
    handover_at: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── requestPickupOtp ────────────────────────────────────────────────────────
  describe('requestPickupOtp', () => {
    it('generates OTP, stores hash, sends SMS, and emits audit event', async () => {
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerId').mockResolvedValue(
        mockBookingRow,
      );
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));
      jest.spyOn(bookingRepository, 'upsertPickupVerification').mockResolvedValue({});
      jest.spyOn(otpProvider, 'storeOtpState').mockResolvedValue(true);
      jest.spyOn(smsProvider, 'sendPickupOtp').mockResolvedValue({ success: true });
      jest.spyOn(auditService, 'logEvent').mockReturnValue({});

      const result = await bookingService.requestPickupOtp({ bookingId, partnerId, userId });

      expect(result.success).toBe(true);
      expect(result.message).toBe('Pickup OTP sent to customer successfully');
      expect(result.otp).toBeUndefined(); // Crucial: zero OTP leakage

      expect(bookingRepository.upsertPickupVerification).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId,
          isVerified: false,
        }),
        expect.anything(),
      );

      expect(smsProvider.sendPickupOtp).toHaveBeenCalledWith(
        expect.objectContaining({
          phone: '+919876543210',
          bookingNumber: 'BK-70492',
        }),
      );

      expect(auditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'BOOKING_PICKUP_OTP_DISPATCHED',
          entityType: 'BOOKING',
          entityId: bookingId,
        }),
      );
    });

    it('throws NotFoundError if booking does not exist or partner does not own vehicle', async () => {
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerId').mockResolvedValue(null);

      await expect(
        bookingService.requestPickupOtp({ bookingId, partnerId, userId }),
      ).rejects.toThrow(NotFoundError);
    });

    it('throws ConflictError if booking is already in ACTIVE status', async () => {
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerId').mockResolvedValue({
        ...mockBookingRow,
        booking_status: 'ACTIVE',
      });

      await expect(
        bookingService.requestPickupOtp({ bookingId, partnerId, userId }),
      ).rejects.toThrow(ConflictError);
    });

    it('throws ConflictError if booking is in CANCELLED status', async () => {
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerId').mockResolvedValue({
        ...mockBookingRow,
        booking_status: 'CANCELLED',
      });

      await expect(
        bookingService.requestPickupOtp({ bookingId, partnerId, userId }),
      ).rejects.toThrow(ConflictError);
    });
  });

  // ── verifyPickupAndActivate ────────────────────────────────────────────────
  describe('verifyPickupAndActivate', () => {
    it('successfully verifies valid OTP and transitions booking and vehicle to ACTIVE', async () => {
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue(
        mockBookingRow,
      );
      jest.spyOn(bookingRepository, 'findConflictingActiveBooking').mockResolvedValue(null);
      jest.spyOn(otpProvider, 'getAttempts').mockResolvedValue(0);

      const salt = otpProvider.generateSalt();
      const otpHash = otpProvider.hashOtp('4829', salt);
      jest.spyOn(otpProvider, 'getOtpState').mockResolvedValue({ otpHash, salt });
      jest.spyOn(otpProvider, 'clearOtpState').mockResolvedValue();

      jest.spyOn(bookingRepository, 'upsertPickupVerification').mockResolvedValue({
        id: 'verif-101',
        verified_at: '2026-09-25T10:05:00.000Z',
      });
      jest.spyOn(bookingRepository, 'updateBookingStatus').mockResolvedValue({});
      jest.spyOn(vehicleRepository, 'updateRentalStatus').mockResolvedValue({});
      jest.spyOn(auditService, 'logEvent').mockReturnValue({});

      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerId').mockResolvedValue({
        ...mockBookingRow,
        booking_status: 'ACTIVE',
        handover_at: '2026-09-25T10:05:00.000Z',
      });

      const res = await bookingService.verifyPickupAndActivate({
        bookingId,
        partnerId,
        userId,
        payload: {
          otp: '4829',
          odometerStart: 12500,
          fuelLevelStart: 'FULL',
          depositCollected: true,
        },
      });

      expect(res.id).toBe(bookingId);
      expect(res.status).toBe('ACTIVE');
      expect(res.bookingStatus).toBe('ACTIVE');
      expect(res.handoverAt).toBe('2026-09-25T10:05:00.000Z');

      expect(bookingRepository.updateBookingStatus).toHaveBeenCalledWith(
        bookingId,
        'ACTIVE',
        expect.anything(),
      );
      expect(vehicleRepository.updateRentalStatus).toHaveBeenCalledWith(
        vehicleId,
        'ACTIVE',
        expect.anything(),
      );
      expect(otpProvider.clearOtpState).toHaveBeenCalledWith(bookingId);
    });

    it('pickup on an archived vehicle never auto-restores an ADMIN-held (is_active=false) vehicle', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb(client));
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue({
        ...mockBookingRow,
        vehicle_is_archived: true,
      });
      jest.spyOn(bookingRepository, 'findConflictingActiveBooking').mockResolvedValue(null);
      jest.spyOn(otpProvider, 'getAttempts').mockResolvedValue(0);
      const salt = otpProvider.generateSalt();
      jest.spyOn(otpProvider, 'getOtpState').mockResolvedValue({ otpHash: otpProvider.hashOtp('4829', salt), salt });
      jest.spyOn(otpProvider, 'clearOtpState').mockResolvedValue();
      jest.spyOn(bookingRepository, 'upsertPickupVerification').mockResolvedValue({ id: 'verif-1' });
      jest.spyOn(bookingRepository, 'updateBookingStatus').mockResolvedValue({});
      jest.spyOn(vehicleRepository, 'updateRentalStatus').mockResolvedValue({});
      jest.spyOn(auditService, 'logEvent').mockReturnValue({});
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerId').mockResolvedValue({
        ...mockBookingRow, booking_status: 'ACTIVE',
      });

      await bookingService.verifyPickupAndActivate({
        bookingId,
        partnerId,
        userId,
        payload: {
          otp: '4829', odometerStart: 12500, fuelLevelStart: 'FULL', depositCollected: true,
        },
      });

      const restoreCall = client.query.mock.calls.find(([sql]) => /SET is_archived = false/.test(sql));
      expect(restoreCall).toBeDefined();
      const [restoreSql, restoreParams] = restoreCall;
      expect(restoreSql).toMatch(/COALESCE\(\(to_jsonb\(vehicles\) ->> 'is_active'\)::boolean, true\)/);
      expect(restoreParams).toEqual([vehicleId]);

      // Execute the exact statement on pg-mem (to_jsonb(record) registered as a harness shim):
      // an admin-deactivated row stays archived; a partner-archived row (is_active true) is restored.
      // eslint-disable-next-line global-require
      const { newDb, DataType } = require('pg-mem');
      const db = newDb();
      db.public.registerFunction({
        name: 'to_jsonb', args: [DataType.record], returns: DataType.jsonb, implementation: (r) => r,
      });
      db.public.none(`
        CREATE TABLE vehicles (id TEXT PRIMARY KEY, is_archived BOOLEAN, is_active BOOLEAN, updated_at TIMESTAMPTZ);
        INSERT INTO vehicles VALUES ('admin-held', true, false, NULL), ('partner-archived', true, true, NULL);
      `);
      const { Client } = db.adapters.createPg();
      const pgClient = new Client();
      await pgClient.connect();
      await pgClient.query(restoreSql, ['admin-held']);
      await pgClient.query(restoreSql, ['partner-archived']);
      expect(db.public.one("SELECT is_archived FROM vehicles WHERE id = 'admin-held'").is_archived).toBe(true);
      expect(db.public.one("SELECT is_archived FROM vehicles WHERE id = 'partner-archived'").is_archived).toBe(false);
    });

    it('handles idempotent replay for already ACTIVE and verified booking', async () => {
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue({
        ...mockBookingRow,
        booking_status: 'ACTIVE',
      });
      jest.spyOn(bookingRepository, 'findPickupVerificationByBookingId').mockResolvedValue({
        id: 'verif-101',
        is_verified: true,
      });
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerId').mockResolvedValue({
        ...mockBookingRow,
        booking_status: 'ACTIVE',
        handover_at: '2026-09-25T10:05:00.000Z',
      });

      const res = await bookingService.verifyPickupAndActivate({
        bookingId,
        partnerId,
        userId,
        payload: { otp: '4829' },
      });

      expect(res.status).toBe('ACTIVE');
      expect(bookingRepository.updateBookingStatus).not.toHaveBeenCalled();
    });

    it('rejects verification if booking is CANCELLED', async () => {
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue({
        ...mockBookingRow,
        booking_status: 'CANCELLED',
      });

      await expect(
        bookingService.verifyPickupAndActivate({
          bookingId,
          partnerId,
          userId,
          payload: { otp: '4829' },
        }),
      ).rejects.toThrow(ConflictError);
    });

    it('rejects verification if vehicle has conflicting active rental', async () => {
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue(
        mockBookingRow,
      );
      jest.spyOn(bookingRepository, 'findConflictingActiveBooking').mockResolvedValue({
        id: 'conflicting-booking-id',
        booking_status: 'ACTIVE',
      });

      await expect(
        bookingService.verifyPickupAndActivate({
          bookingId,
          partnerId,
          userId,
          payload: { otp: '4829' },
        }),
      ).rejects.toThrow(ConflictError);
    });

    it('rejects verification if scheduled return time has passed without vehicle handover', async () => {
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue({
        ...mockBookingRow,
        expected_return_at: new Date(Date.now() - 1000).toISOString(),
      });

      await expect(
        bookingService.verifyPickupAndActivate({
          bookingId,
          partnerId,
          userId,
          payload: { otp: '4829' },
        }),
      ).rejects.toThrow('Booking has expired because the scheduled return time has passed without vehicle handover');
    });

    it('rejects invalid OTP and increments attempt counter', async () => {
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue(
        mockBookingRow,
      );
      jest.spyOn(bookingRepository, 'findConflictingActiveBooking').mockResolvedValue(null);
      jest.spyOn(otpProvider, 'getAttempts').mockResolvedValue(1);

      const salt = otpProvider.generateSalt();
      const otpHash = otpProvider.hashOtp('4829', salt);
      jest.spyOn(otpProvider, 'getOtpState').mockResolvedValue({ otpHash, salt });
      jest.spyOn(otpProvider, 'incrementAttempts').mockResolvedValue(2);

      await expect(
        bookingService.verifyPickupAndActivate({
          bookingId,
          partnerId,
          userId,
          payload: { otp: '0000' }, // wrong OTP
        }),
      ).rejects.toThrow(ValidationError);

      expect(otpProvider.incrementAttempts).toHaveBeenCalledWith(bookingId);
    });

    it('locks out verification when maximum 5 failed attempts are reached', async () => {
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerIdForUpdate').mockResolvedValue(
        mockBookingRow,
      );
      jest.spyOn(bookingRepository, 'findConflictingActiveBooking').mockResolvedValue(null);
      jest.spyOn(otpProvider, 'getAttempts').mockResolvedValue(5);

      await expect(
        bookingService.verifyPickupAndActivate({
          bookingId,
          partnerId,
          userId,
          payload: { otp: '4829' },
        }),
      ).rejects.toThrow(ValidationError);
    });
  });
});
