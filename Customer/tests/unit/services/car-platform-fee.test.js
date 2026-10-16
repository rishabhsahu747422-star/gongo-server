'use strict';

const platformFeeService = require('../../../src/services/platform-fee.service');
const { resolveVehicleCategory } = require('../../../src/utils/vehicle-category');
const pricingService = require('../../../src/services/pricing.service');

describe('Car vs Bike Platform Fee Pricing Separation', () => {
  describe('Vehicle Category Resolution', () => {
    it('resolves cars from category_slug', () => {
      expect(resolveVehicleCategory({ category_slug: 'CAR' })).toBe('CAR');
      expect(resolveVehicleCategory({ category_slug: 'car' })).toBe('CAR');
      expect(resolveVehicleCategory({ category_slug: 'SEDAN' })).toBe('CAR');
      expect(resolveVehicleCategory({ category_slug: 'SUV' })).toBe('CAR');
      expect(resolveVehicleCategory({ category_slug: 'HATCHBACK' })).toBe('CAR');
    });

    it('resolves cars from seats count > 2', () => {
      expect(resolveVehicleCategory({ seats: 4 })).toBe('CAR');
      expect(resolveVehicleCategory({ seats: 5 })).toBe('CAR');
      expect(resolveVehicleCategory({ seats: 7 })).toBe('CAR');
    });

    it('resolves bikes from category or seats <= 2', () => {
      expect(resolveVehicleCategory({ category_slug: 'BIKE' })).toBe('BIKE');
      expect(resolveVehicleCategory({ category_slug: 'SCOOTER' })).toBe('BIKE');
      expect(resolveVehicleCategory({ seats: 2 })).toBe('BIKE');
      expect(resolveVehicleCategory({})).toBe('BIKE');
      expect(resolveVehicleCategory(null)).toBe('BIKE');
    });
  });

  describe('Platform Fee Calculation — Car vs Bike', () => {
    const mockDbRows = [
      // Bike charges
      { charge_type: 'service_charge', calculation_type: 'fixed', value: '2.50', currency: 'INR', is_active: true },
      { charge_type: 'convenience_fee', calculation_type: 'fixed', value: '2.00', currency: 'INR', is_active: true },
      { charge_type: 'gst', calculation_type: 'percentage', value: '18.00', currency: 'INR', is_active: true },
      // Car charges
      { charge_type: 'service_charge_car', calculation_type: 'fixed', value: '5.00', currency: 'INR', is_active: true },
      { charge_type: 'convenience_fee_car', calculation_type: 'fixed', value: '3.00', currency: 'INR', is_active: true },
      { charge_type: 'gst_car', calculation_type: 'percentage', value: '18.00', currency: 'INR', is_active: true },
    ];

    const mockClient = {
      query: jest.fn().mockResolvedValue({ rows: mockDbRows }),
    };

    it('calculates CAR fees using car-specific settings (₹5.00 SC + ₹3.00 CF + 18% GST = ₹9.44)', async () => {
      const result = await platformFeeService.calculateChargesForRental(100, mockClient, { vehicleCategory: 'CAR' });

      expect(result.serviceCharge).toBe(5.00);
      expect(result.convenienceFee).toBe(3.00);
      expect(result.platformFee).toBe(8.00);
      expect(result.gst).toBe(1.44); // 18% of 8.00
      expect(result.totalFeesAndTax).toBe(9.44); // 8.00 + 1.44
      expect(result.vehicleCategory).toBe('CAR');
    });

    it('calculates BIKE fees using existing bike settings (₹2.50 SC + ₹2.00 CF + 18% GST = ₹5.31)', async () => {
      const result = await platformFeeService.calculateChargesForRental(100, mockClient, { vehicleCategory: 'BIKE' });

      expect(result.serviceCharge).toBe(2.50);
      expect(result.convenienceFee).toBe(2.00);
      expect(result.platformFee).toBe(4.50);
      expect(result.gst).toBe(0.81); // 18% of 4.50
      expect(result.totalFeesAndTax).toBe(5.31);
      expect(result.vehicleCategory).toBe('BIKE');
    });

    it('defaults to BIKE settings when vehicleCategory is omitted (complete backward compatibility)', async () => {
      const result = await platformFeeService.calculateChargesForRental(100, mockClient);

      expect(result.serviceCharge).toBe(2.50);
      expect(result.convenienceFee).toBe(2.00);
      expect(result.platformFee).toBe(4.50);
      expect(result.gst).toBe(0.81);
      expect(result.totalFeesAndTax).toBe(5.31);
      expect(result.vehicleCategory).toBe('BIKE');
    });
  });

  describe('Pricing Quote Calculation with Car Platform Fees', () => {
    it('calculates quote for Car with Car platform fees', async () => {
      const mockCar = {
        id: 'car-uuid-001',
        brand: 'Hyundai',
        model: 'Creta',
        category_slug: 'CAR',
        seats: 5,
        price_per_hour: 150,
        price_per_day: 1500,
        security_deposit: 3000,
      };

      // Mock calculateChargesForRental for this test
      jest.spyOn(platformFeeService, 'calculateChargesForRental').mockResolvedValueOnce({
        serviceCharge: 5.00,
        convenienceFee: 3.00,
        gst: 1.44,
        platformFee: 8.00,
        totalFeesAndTax: 9.44,
        vehicleCategory: 'CAR',
      });

      const quote = await pricingService.calculateQuote({
        vehicle: mockCar,
        rentalType: 'HOURLY',
        startAt: '2026-10-15T10:00:00Z',
        endAt: '2026-10-15T13:00:00Z',
        customerId: 'cus-1',
      });

      expect(quote.serviceCharge).toBe(5.00);
      expect(quote.convenienceFee).toBe(3.00);
      expect(quote.platformFee).toBe(8.00);
      expect(quote.gst).toBe(1.44);
      // payableAmount = rentalAmount (450) + convenienceFee (3) + serviceCharge (5) + gst (1.44) = 459.44
      expect(quote.payableAmount).toBe(459.44);
    });

    it('calculates quote for Bike with Bike platform fees', async () => {
      const mockBike = {
        id: 'bike-uuid-001',
        brand: 'Honda',
        model: 'Activa',
        category_slug: 'BIKE',
        seats: 2,
        price_per_hour: 50,
        price_per_day: 400,
        security_deposit: 1000,
      };

      jest.spyOn(platformFeeService, 'calculateChargesForRental').mockResolvedValueOnce({
        serviceCharge: 2.50,
        convenienceFee: 2.00,
        gst: 0.81,
        platformFee: 4.50,
        totalFeesAndTax: 5.31,
        vehicleCategory: 'BIKE',
      });

      const quote = await pricingService.calculateQuote({
        vehicle: mockBike,
        rentalType: 'HOURLY',
        startAt: '2026-10-15T10:00:00Z',
        endAt: '2026-10-15T13:00:00Z',
        customerId: 'cus-1',
      });

      expect(quote.serviceCharge).toBe(2.50);
      expect(quote.convenienceFee).toBe(2.00);
      expect(quote.platformFee).toBe(4.50);
      expect(quote.gst).toBe(0.81);
      // payableAmount = rentalAmount (150) + convenienceFee (2) + serviceCharge (2.5) + gst (0.81) = 155.31
      expect(quote.payableAmount).toBe(155.31);
    });
  });
});
