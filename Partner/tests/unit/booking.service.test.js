'use strict';

const bookingService = require('../../src/services/booking.service');
const bookingRepository = require('../../src/repositories/booking.repository');
const { NotFoundError } = require('../../src/errors');

describe('Unit: BookingService', () => {
  const partnerId = '11111111-1111-4111-a111-111111111111';
  const bookingId = '22222222-2222-4222-a222-222222222222';
  const vehicleId = '33333333-3333-4333-a333-333333333333';

  const mockDbRow = {
    id: bookingId,
    booking_number: 'BK-1001',
    customer_id: '44444444-4444-4444-a444-444444444444',
    customer_name: 'Rahul Sharma',
    customer_phone: '+919876543210',
    partner_id: partnerId,
    shop_id: '55555555-5555-4555-a555-555555555555',
    vehicle_id: vehicleId,
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

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getBookings', () => {
    it('returns formatted bookings with pagination', async () => {
      jest.spyOn(bookingRepository, 'findBookingsByPartnerId').mockResolvedValue([mockDbRow]);
      jest.spyOn(bookingRepository, 'countBookingsByPartnerId').mockResolvedValue(1);

      const result = await bookingService.getBookings({
        partnerId,
        query: { page: 1, limit: 10 },
      });

      expect(bookingRepository.findBookingsByPartnerId).toHaveBeenCalledTimes(1);
      expect(bookingRepository.countBookingsByPartnerId).toHaveBeenCalledTimes(1);
      expect(result.bookings).toHaveLength(1);

      const item = result.bookings[0];
      expect(item.id).toBe(bookingId);
      expect(item.bookingNumber).toBe('BK-1001');
      // CONFIRMED maps to UPCOMING for partner UI
      expect(item.status).toBe('UPCOMING');
      expect(item.bookingStatus).toBe('CONFIRMED');
      expect(item.vehicleName).toBe('Royal Enfield Classic 350 Dark Stealth');
      expect(item.vehicleImage).toBe('vehicles/images/cover-123.jpg');
      expect(item.bookingAmount).toBe(2000);
      expect(item.securityDeposit).toBe(3000);
      expect(item.customerName).toBe('Rahul Sharma');
      expect(item.pricing).toBeDefined();
      expect(item.pricing.baseAmount).toBe(1600);
      expect(item.pricing.totalCustomerAmount).toBe(5124);

      // Verify no commission leakage
      expect(item.pricing.commissionAmount).toBeUndefined();
      expect(item.pricing.commissionRate).toBeUndefined();
      expect(item.commissionAmount).toBeUndefined();

      expect(result.pagination).toEqual({
        total: 1,
        page: 1,
        limit: 10,
        totalPages: 1,
      });
    });

    it('handles empty booking list gracefully', async () => {
      jest.spyOn(bookingRepository, 'findBookingsByPartnerId').mockResolvedValue([]);
      jest.spyOn(bookingRepository, 'countBookingsByPartnerId').mockResolvedValue(0);

      const result = await bookingService.getBookings({ partnerId });
      expect(result.bookings).toEqual([]);
      expect(result.pagination.total).toBe(0);
      expect(result.pagination.totalPages).toBe(1);
    });

    it('maps ACTIVE bookings correctly preserving status and handover_at', async () => {
      const activeRow = {
        ...mockDbRow,
        booking_status: 'ACTIVE',
        handover_at: '2026-09-25T10:05:00.000Z',
      };

      jest.spyOn(bookingRepository, 'findBookingsByPartnerId').mockResolvedValue([activeRow]);
      jest.spyOn(bookingRepository, 'countBookingsByPartnerId').mockResolvedValue(1);

      const result = await bookingService.getBookings({ partnerId, query: { tab: 'Active' } });
      const item = result.bookings[0];
      expect(item.status).toBe('ACTIVE');
      expect(item.handoverAt).toBe('2026-09-25T10:05:00.000Z');
    });
  });

  describe('getBookingById', () => {
    it('returns formatted single booking when found and owned by partner', async () => {
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerId').mockResolvedValue(mockDbRow);

      const result = await bookingService.getBookingById({ bookingId, partnerId });
      expect(bookingRepository.findBookingByIdAndPartnerId).toHaveBeenCalledWith(
        bookingId,
        partnerId,
      );
      expect(result.id).toBe(bookingId);
      expect(result.customerPhone).toBe('+919876543210');
      expect(result.pickupLocation).toBe('Indiranagar Hub, Bangalore');
      expect(result.pricing.securityDeposit).toBe(3000);
      // Zero commission leakage check
      expect(result.pricing.commissionAmount).toBeUndefined();
      expect(result.commission).toBeUndefined();
    });

    it('throws NotFoundError when booking not found or partner does not own vehicle', async () => {
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerId').mockResolvedValue(null);

      await expect(
        bookingService.getBookingById({ bookingId, partnerId }),
      ).rejects.toThrow(NotFoundError);
    });
  });
});
