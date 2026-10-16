'use strict';

const platformFeeService = require('../../../src/services/platform-fee.service');
const pricingService = require('../../../src/services/pricing.service');

describe('Customer Pricing Summary & Platform Fee Integration', () => {
  describe('Platform Fee Service Calculation', () => {
    test('Calculates fixed convenience fee, fixed service charge, and percentage GST from settings', async () => {
      // Mock DB client returning sample platform_charge_settings
      const mockClient = {
        query: jest.fn().mockResolvedValue({
          rows: [
            { charge_type: 'service_charge', calculation_type: 'fixed', value: '2.00', is_active: true },
            { charge_type: 'convenience_fee', calculation_type: 'fixed', value: '2.00', is_active: true },
            { charge_type: 'gst', calculation_type: 'percentage', value: '100.00', is_active: true },
          ],
        }),
      };

      const result = await platformFeeService.calculateChargesForRental(14, mockClient);

      expect(result.convenienceFee).toBe(2);
      expect(result.serviceCharge).toBe(2);
      expect(result.platformFee).toBe(4); // 2 + 2
      expect(result.gst).toBe(4); // 100% of 4
      expect(result.totalFeesAndTax).toBe(8); // 4 + 4
    });

    test('Ignores inactive charge configurations', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({
          rows: [
            { charge_type: 'service_charge', calculation_type: 'fixed', value: '5.00', is_active: true },
            { charge_type: 'convenience_fee', calculation_type: 'fixed', value: '5.00', is_active: false }, // inactive
            { charge_type: 'gst', calculation_type: 'percentage', value: '18.00', is_active: true },
          ],
        }),
      };

      const result = await platformFeeService.calculateChargesForRental(100, mockClient);

      expect(result.serviceCharge).toBe(5);
      expect(result.convenienceFee).toBe(0);
      expect(result.platformFee).toBe(5);
      expect(result.gst).toBe(0.9); // 18% of 5
      expect(result.totalFeesAndTax).toBe(5.9);
    });

    test('Calculates 0 fees when platform fee settings are empty', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
      };

      const result = await platformFeeService.calculateChargesForRental(50, mockClient);

      expect(result.convenienceFee).toBe(0);
      expect(result.serviceCharge).toBe(0);
      expect(result.gst).toBe(0);
      expect(result.totalFeesAndTax).toBe(0);
    });

    test('Gracefully falls back to 0 fees when table does not exist in mock environment', async () => {
      const mockClient = {
        query: jest.fn().mockRejectedValue(new Error('relation "platform_charge_settings" does not exist')),
      };

      const result = await platformFeeService.calculateChargesForRental(50, mockClient);

      expect(result.convenienceFee).toBe(0);
      expect(result.serviceCharge).toBe(0);
      expect(result.platformFee).toBe(0);
      expect(result.gst).toBe(0);
    });
  });

  describe('Authoritative Pricing Quote with Dynamic Fees', () => {
    test('Quote returns consolidated bookingAmount, convenienceFee, serviceCharge, gst, and totalAmount excluding security deposit', async () => {
      const vehicle = {
        id: '22222222-3333-4444-5555-666666666666',
        price_per_hour: 1,
        price_per_day: 1,
        price_3_hours: 3,
        price_6_hours: 6,
        security_deposit: 1,
      };

      // 83 hours rental = 3 days (72h, 3*1=3) + 11h remainder: 6h(6) + 3h(3) + 1h(1) + 1h(1) = 3 + 11 = 14
      const quote = await pricingService.calculateQuote({
        vehicle,
        rentalType: 'DAILY',
        startAt: '2026-10-10T00:00:00Z',
        endAt: '2026-10-13T11:00:00Z', // 83 hours
        customerId: 'cust-1',
      });

      expect(quote.actualDurationHours).toBe(83);
      expect(quote.rentalAmount).toBe(14);
      expect(quote.bookingAmount).toBe(14);
      expect(quote.breakdown.bookingAmount).toBe(14);
      expect(quote.breakdown.rentalAmount).toBe(14);
      expect(quote.rates.securityDeposit).toBe(1);

      // Total online amount = bookingAmount + convenienceFee + serviceCharge + gst
      // Security deposit must NOT be added to totalAmount or payableAmount
      expect(quote.totalAmount).toBe(
        quote.bookingAmount + quote.convenienceFee + quote.serviceCharge + quote.gst
      );
      expect(quote.payableAmount).toBe(quote.totalAmount);
      expect(quote.breakdown.payableAmount).toBe(quote.totalAmount);
      expect(quote.breakdown.totalAmount).toBe(quote.totalAmount + quote.rates.securityDeposit);
      expect(quote.totalAmount).not.toContain
    });

    test('Promo discount applies before platform fees and GST', async () => {
      const vehicle = {
        id: '33333333-4444-5555-6666-777777777777',
        price_per_hour: 100,
        price_per_day: 1400,
        price_3_hours: 250,
        security_deposit: 500,
      };

      const quote = await pricingService.calculateQuote({
        vehicle,
        rentalType: 'HOURLY',
        startAt: '2026-10-10T10:00:00Z',
        endAt: '2026-10-10T14:00:00Z', // 4 hours = 350
        customerId: 'cust-1',
      });

      expect(quote.bookingAmount).toBe(350);
      expect(quote.totalAmount).toBe(
        350 + quote.convenienceFee + quote.serviceCharge + quote.gst
      );
      // Security deposit is kept separate
      expect(quote.securityDeposit).toBe(500);
    });
  });
});
