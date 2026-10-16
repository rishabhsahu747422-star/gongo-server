'use strict';

const adminBookingService = require('../../src/services/admin-booking.service');
const adminBookingRepository = require('../../src/repositories/admin-booking.repository');
const adminActionRepository = require('../../src/repositories/admin-action.repository');
const auditService = require('../../src/services/audit.service');
const { ValidationError, NotFoundError } = require('../../src/errors');

describe('Unit: AdminBookingService', () => {
  const TEST_BOOKING_ID = 'e1111111-1111-4111-a111-111111111111';
  const TEST_CUSTOMER_ID = 'c1111111-1111-4111-a111-111111111111';
  const TEST_PARTNER_ID = 'b1111111-1111-4111-a111-111111111111';
  const TEST_VEHICLE_ID = 'd1111111-1111-4111-a111-111111111111';

  const mockBookingRecord = {
    id: TEST_BOOKING_ID,
    bookingNumber: 'BK-2026-0001',
    customerId: TEST_CUSTOMER_ID,
    partnerId: TEST_PARTNER_ID,
    vehicleId: TEST_VEHICLE_ID,
    startAt: new Date('2026-09-01T10:00:00.000Z'),
    expectedReturnAt: new Date('2026-09-03T10:00:00.000Z'),
    bookingStatus: 'CONFIRMED',
    paymentStatus: 'COMPLETED',
    pickupLocation: 'Indiranagar Hub, Bengaluru',
    createdAt: new Date('2026-09-01T08:00:00.000Z'),
    updatedAt: new Date('2026-09-01T08:00:00.000Z'),
    customer: {
      id: TEST_CUSTOMER_ID,
      name: 'Rajesh Kumar',
      phone: '9876543210',
      email: 'rajesh@example.com',
    },
    partner: {
      id: TEST_PARTNER_ID,
      businessName: 'Apex Mobility',
      ownerName: 'Suresh Patel',
    },
    vehicle: {
      id: TEST_VEHICLE_ID,
      registrationNumber: 'KA-01-MJ-9999',
      brand: 'Tata',
      model: 'Nexon EV',
      category: 'SUV',
      rentalStatus: 'IDLE',
      manualStatus: 'ONLINE',
    },
    pricing: {
      totalCustomerAmount: 4000,
      currency: 'INR',
    },
  };

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(adminBookingRepository, 'withTransaction').mockImplementation(async (cb) => cb({}));
    jest.spyOn(adminActionRepository, 'createAction').mockResolvedValue({ id: 'act-1' });
    jest.spyOn(auditService, 'logAdminAction').mockImplementation((evt) => evt);
  });

  describe('listBookings', () => {
    it('returns bookings list and pagination metadata', async () => {
      jest.spyOn(adminBookingRepository, 'listBookings').mockResolvedValue({
        bookings: [mockBookingRecord],
        total: 1,
      });

      const res = await adminBookingService.listBookings({ limit: '10', offset: '0' });

      expect(res.bookings).toHaveLength(1);
      expect(res.pagination.total).toBe(1);
      expect(res.pagination.pages).toBe(1);
    });

    it('rejects invalid bookingStatus enum', async () => {
      await expect(
        adminBookingService.listBookings({ bookingStatus: 'UNKNOWN_STATUS' }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects invalid paymentStatus enum', async () => {
      await expect(
        adminBookingService.listBookings({ paymentStatus: 'UNKNOWN_PAY_STATUS' }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects invalid UUID filters', async () => {
      await expect(
        adminBookingService.listBookings({ customerId: 'not-a-uuid' }),
      ).rejects.toThrow(ValidationError);

      await expect(
        adminBookingService.listBookings({ partnerId: 'not-a-uuid' }),
      ).rejects.toThrow(ValidationError);

      await expect(
        adminBookingService.listBookings({ vehicleId: 'not-a-uuid' }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects malformed date range filters', async () => {
      await expect(
        adminBookingService.listBookings({ startDate: '2026-09-05' }),
      ).rejects.toThrow(ValidationError);

      await expect(
        adminBookingService.listBookings({ startDate: 'bad-date', endDate: '2026-09-05' }),
      ).rejects.toThrow(ValidationError);

      await expect(
        adminBookingService.listBookings({ startDate: '2026-09-10', endDate: '2026-09-01' }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects date range exceeding 366 days', async () => {
      await expect(
        adminBookingService.listBookings({
          startDate: '2024-01-01',
          endDate: '2026-01-01',
        }),
      ).rejects.toThrow('Date range cannot exceed 366 days');
    });

    it('rejects non-positive limit or negative offset', async () => {
      await expect(
        adminBookingService.listBookings({ limit: '0' }),
      ).rejects.toThrow(ValidationError);

      await expect(
        adminBookingService.listBookings({ offset: '-1' }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('getBookingDetail', () => {
    it('returns full booking detail with summaries, payments, and damages', async () => {
      jest.spyOn(adminBookingRepository, 'findBookingById').mockResolvedValue(mockBookingRecord);
      jest.spyOn(adminBookingRepository, 'getBookingSummaries').mockResolvedValue({
        pricingSnapshot: { totalCustomerAmount: 4000 },
        pickupVerification: { isVerified: true },
        returnVerification: null,
      });
      jest.spyOn(adminBookingRepository, 'getBookingPayments').mockResolvedValue([
        { id: 'pay-1', amount: 4000, status: 'SUCCESS' },
      ]);
      jest.spyOn(adminBookingRepository, 'getBookingDamages').mockResolvedValue([]);

      const detail = await adminBookingService.getBookingDetail(TEST_BOOKING_ID);

      expect(detail.booking.id).toBe(TEST_BOOKING_ID);
      expect(detail.pricingSnapshot.totalCustomerAmount).toBe(4000);
      expect(detail.pickupVerification.isVerified).toBe(true);
      expect(detail.payments).toHaveLength(1);
    });

    it('throws NotFoundError when booking does not exist', async () => {
      jest.spyOn(adminBookingRepository, 'findBookingById').mockResolvedValue(null);

      await expect(
        adminBookingService.getBookingDetail(TEST_BOOKING_ID),
      ).rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError when bookingId is not a UUID', async () => {
      await expect(
        adminBookingService.getBookingDetail('invalid-uuid'),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('updateBookingStatus', () => {
    it('rejects unapproved fields (mass assignment protection)', async () => {
      await expect(
        adminBookingService.updateBookingStatus(TEST_BOOKING_ID, {
          status: 'ACTIVE',
          customerId: 'c9999999-9999-4999-a999-999999999999',
        }),
      ).rejects.toThrow("Field 'customerId' is not allowed");
    });

    it('rejects missing or invalid status value', async () => {
      await expect(
        adminBookingService.updateBookingStatus(TEST_BOOKING_ID, {}),
      ).rejects.toThrow('status field is required');

      await expect(
        adminBookingService.updateBookingStatus(TEST_BOOKING_ID, { status: 'INVALID_ENUM' }),
      ).rejects.toThrow(ValidationError);
    });

    it('returns existing booking when status is identical (noop)', async () => {
      jest.spyOn(adminBookingRepository, 'findBookingByIdForUpdate').mockResolvedValue({
        ...mockBookingRecord,
        bookingStatus: 'CONFIRMED',
      });
      jest.spyOn(adminBookingRepository, 'findBookingById').mockResolvedValue(mockBookingRecord);

      const res = await adminBookingService.updateBookingStatus(TEST_BOOKING_ID, {
        status: 'CONFIRMED',
      });

      expect(res.id).toBe(TEST_BOOKING_ID);
      expect(adminActionRepository.createAction).not.toHaveBeenCalled();
    });

    it('rejects mutating a COMPLETED booking', async () => {
      jest.spyOn(adminBookingRepository, 'findBookingByIdForUpdate').mockResolvedValue({
        ...mockBookingRecord,
        bookingStatus: 'COMPLETED',
      });

      await expect(
        adminBookingService.updateBookingStatus(TEST_BOOKING_ID, { status: 'CANCELLED' }),
      ).rejects.toThrow('Cannot change status of a COMPLETED booking');
    });

    it('rejects mutating a CANCELLED booking', async () => {
      jest.spyOn(adminBookingRepository, 'findBookingByIdForUpdate').mockResolvedValue({
        ...mockBookingRecord,
        bookingStatus: 'CANCELLED',
      });

      await expect(
        adminBookingService.updateBookingStatus(TEST_BOOKING_ID, { status: 'ACTIVE' }),
      ).rejects.toThrow('Cannot change status of a CANCELLED booking');
    });

    it('rejects invalid state transition (CONFIRMED -> COMPLETED) without force', async () => {
      jest.spyOn(adminBookingRepository, 'findBookingByIdForUpdate').mockResolvedValue({
        ...mockBookingRecord,
        bookingStatus: 'CONFIRMED',
      });

      await expect(
        adminBookingService.updateBookingStatus(TEST_BOOKING_ID, { status: 'COMPLETED' }),
      ).rejects.toThrow('Invalid booking status transition');
    });

    it('executes valid state transition and coordinates vehicle rental status', async () => {
      jest.spyOn(adminBookingRepository, 'findBookingByIdForUpdate').mockResolvedValue({
        ...mockBookingRecord,
        bookingStatus: 'CONFIRMED',
      });
      const updateVehicleSpy = jest.spyOn(
        adminBookingRepository,
        'updateVehicleRentalStatus',
      ).mockResolvedValue(true);
      jest.spyOn(adminBookingRepository, 'updateBookingStatus').mockResolvedValue({
        ...mockBookingRecord,
        bookingStatus: 'ACTIVE',
      });

      const updated = await adminBookingService.updateBookingStatus(
        TEST_BOOKING_ID,
        { status: 'ACTIVE', reason: 'Customer arrived and checked in' },
        { actorId: 'admin-1', actorRole: 'ADMIN', permission: 'bookings.update' },
      );

      expect(updated.bookingStatus).toBe('ACTIVE');
      expect(updateVehicleSpy).toHaveBeenCalledWith(TEST_VEHICLE_ID, 'ACTIVE', expect.anything());
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'BOOKING_STATUS_CHANGE',
          targetResource: 'BOOKING',
          targetResourceId: TEST_BOOKING_ID,
        }),
        expect.anything(),
      );
    });
  });

  describe('cancelBooking', () => {
    it('rejects disallowed fields in cancel payload', async () => {
      await expect(
        adminBookingService.cancelBooking(TEST_BOOKING_ID, {
          reason: 'Valid cancellation reason',
          bookingStatus: 'CANCELLED',
        }),
      ).rejects.toThrow("Field 'bookingStatus' is not allowed");
    });

    it('rejects missing or short reason in cancellation', async () => {
      await expect(
        adminBookingService.cancelBooking(TEST_BOOKING_ID, { reason: 'no' }),
      ).rejects.toThrow('Cancellation reason is required');
    });

    it('rejects cancellation if booking is already COMPLETED', async () => {
      jest.spyOn(adminBookingRepository, 'findBookingByIdForUpdate').mockResolvedValue({
        ...mockBookingRecord,
        bookingStatus: 'COMPLETED',
      });

      await expect(
        adminBookingService.cancelBooking(TEST_BOOKING_ID, { reason: 'Late customer request' }),
      ).rejects.toThrow('Cannot cancel a COMPLETED booking');
    });

    it('rejects cancellation if booking is already CANCELLED', async () => {
      jest.spyOn(adminBookingRepository, 'findBookingByIdForUpdate').mockResolvedValue({
        ...mockBookingRecord,
        bookingStatus: 'CANCELLED',
      });

      await expect(
        adminBookingService.cancelBooking(TEST_BOOKING_ID, { reason: 'Duplicate call' }),
      ).rejects.toThrow('Booking is already CANCELLED');
    });

    it('successfully cancels booking, restores vehicle to IDLE, and writes audit', async () => {
      jest.spyOn(adminBookingRepository, 'findBookingByIdForUpdate').mockResolvedValue({
        ...mockBookingRecord,
        bookingStatus: 'UPCOMING',
      });
      const updateVehicleSpy = jest.spyOn(
        adminBookingRepository,
        'updateVehicleRentalStatus',
      ).mockResolvedValue(true);
      jest.spyOn(adminBookingRepository, 'updateBookingStatus').mockResolvedValue({
        ...mockBookingRecord,
        bookingStatus: 'CANCELLED',
      });

      const res = await adminBookingService.cancelBooking(
        TEST_BOOKING_ID,
        { reason: 'Customer requested cancellation due to travel plan change' },
        { actorId: 'admin-1', actorRole: 'ADMIN', permission: 'bookings.cancel' },
      );

      expect(res.bookingStatus).toBe('CANCELLED');
      expect(updateVehicleSpy).toHaveBeenCalledWith(TEST_VEHICLE_ID, 'IDLE', expect.anything());
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'BOOKING_CANCELLED',
          targetResource: 'BOOKING',
          targetResourceId: TEST_BOOKING_ID,
        }),
        expect.anything(),
      );
    });
  });

  describe('getBookingTimeline', () => {
    it('assembles chronologically sorted timeline with events', async () => {
      jest.spyOn(adminBookingRepository, 'findBookingById').mockResolvedValue(mockBookingRecord);
      jest.spyOn(adminBookingRepository, 'getBookingSummaries').mockResolvedValue({
        pickupVerification: {
          verifiedAt: new Date('2026-09-01T10:05:00.000Z'),
          odometerStart: 12500,
        },
        returnVerification: {
          returnedAt: new Date('2026-09-03T10:00:00.000Z'),
          odometerEnd: 12800,
          returnStatus: 'RETURNED_SUCCESS',
        },
      });
      jest.spyOn(adminBookingRepository, 'getBookingPayments').mockResolvedValue([
        {
          id: 'pay-1',
          amount: 4000,
          currency: 'INR',
          provider: 'RAZORPAY',
          status: 'SUCCESS',
          createdAt: new Date('2026-09-01T08:15:00.000Z'),
        },
      ]);
      jest.spyOn(adminBookingRepository, 'getBookingAdminActions').mockResolvedValue([
        {
          id: 'act-1',
          action: 'BOOKING_STATUS_CHANGE',
          actorId: 'admin-1',
          actorRole: 'ADMIN',
          createdAt: new Date('2026-09-01T09:00:00.000Z'),
        },
      ]);

      const timelineData = await adminBookingService.getBookingTimeline(TEST_BOOKING_ID);

      expect(timelineData.bookingId).toBe(TEST_BOOKING_ID);
      expect(timelineData.timeline.length).toBe(5);

      // Verify chronological order
      for (let i = 1; i < timelineData.timeline.length; i += 1) {
        const prevTime = new Date(timelineData.timeline[i - 1].timestamp).getTime();
        const currTime = new Date(timelineData.timeline[i].timestamp).getTime();
        expect(currTime).toBeGreaterThanOrEqual(prevTime);
      }
    });
  });

  describe('auxiliary read methods', () => {
    it('getBookingPayments returns payments list', async () => {
      jest.spyOn(adminBookingRepository, 'findBookingById').mockResolvedValue(mockBookingRecord);
      jest.spyOn(adminBookingRepository, 'getBookingPayments').mockResolvedValue([
        { id: 'pay-1', amount: 4000 },
      ]);

      const res = await adminBookingService.getBookingPayments(TEST_BOOKING_ID);
      expect(res.payments).toHaveLength(1);
    });

    it('getBookingCommission returns commission record', async () => {
      jest.spyOn(adminBookingRepository, 'findBookingById').mockResolvedValue(mockBookingRecord);
      jest.spyOn(adminBookingRepository, 'getBookingCommission').mockResolvedValue({
        commissionAmount: 450,
      });

      const res = await adminBookingService.getBookingCommission(TEST_BOOKING_ID);
      expect(res.commission.commissionAmount).toBe(450);
    });

    it('getBookingSettlement returns partner settlement record', async () => {
      jest.spyOn(adminBookingRepository, 'findBookingById').mockResolvedValue(mockBookingRecord);
      jest.spyOn(adminBookingRepository, 'getBookingSettlement').mockResolvedValue({
        settlementStatus: 'SETTLED',
      });

      const res = await adminBookingService.getBookingSettlement(TEST_BOOKING_ID);
      expect(res.settlement.settlementStatus).toBe('SETTLED');
    });

    it('getBookingTracking returns pickup, return, and damage data', async () => {
      jest.spyOn(adminBookingRepository, 'findBookingById').mockResolvedValue(mockBookingRecord);
      jest.spyOn(adminBookingRepository, 'getBookingSummaries').mockResolvedValue({
        pickupVerification: { isVerified: true },
        returnVerification: null,
      });
      jest.spyOn(adminBookingRepository, 'getBookingDamages').mockResolvedValue([
        { id: 'dmg-1', damageType: 'SCRATCH' },
      ]);

      const res = await adminBookingService.getBookingTracking(TEST_BOOKING_ID);
      expect(res.pickup.isVerified).toBe(true);
      expect(res.damages).toHaveLength(1);
    });
  });
});
