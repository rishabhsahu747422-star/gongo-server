'use strict';

const pricingService = require('../../../src/services/pricing.service');
const PricingService = pricingService.constructor;
const bookingService = require('../../../src/services/booking.service');
const PaymentTimeoutService = require('../../../src/services/payment-timeout.service');

describe('GONGO Booking Rent Calculation — Database Pricing Slabs Suite', () => {
  // Test reference rates configured dynamically as stored in the database:
  // price_per_hour = 120 (1 Hour)
  // price_3_hours = 310  (3 Hours)
  // price_6_hours = 580  (6 Hours)
  // price_12_hours = 1100 (12 Hours)
  // price_per_day = 1950  (1 Day / 24 Hours)
  const dbRates = {
    hourlyRate: 120,
    threeHourRate: 310,
    sixHourRate: 580,
    twelveHourRate: 1100,
    dailyRate: 1950,
  };

  function getSlabSummary(breakdown) {
    return breakdown.map((item) => {
      if (item.type === '1_DAY') return '1 Day';
      if (item.type === '12_HOURS') return '12 Hours';
      if (item.type === '6_HOURS') return '6 Hours';
      if (item.type === '3_HOURS') return '3 Hours';
      if (item.type === '1_HOUR') return '1 Hour';
      return item.label;
    }).join(' + ');
  }

  // TEST 1: Duration = 1 hour -> Expected base rent = configured 3-hour price.
  test('TEST 1: Duration = 1 hour -> Expected base rent = configured 3-hour price', () => {
    const quote = PricingService.calculateRentalPrice({
      actualDurationHours: 1,
      ...dbRates,
    });
    expect(quote.actualDurationHours).toBe(1);
    expect(quote.billableDurationHours).toBe(3);
    expect(quote.rentalAmount).toBe(dbRates.threeHourRate); // 310
    expect(getSlabSummary(quote.pricingBreakdown)).toBe('3 Hours');
  });

  // TEST 2: Duration = 2 hours -> Expected base rent = configured 3-hour price.
  test('TEST 2: Duration = 2 hours -> Expected base rent = configured 3-hour price', () => {
    const quote = PricingService.calculateRentalPrice({
      actualDurationHours: 2,
      ...dbRates,
    });
    expect(quote.actualDurationHours).toBe(2);
    expect(quote.billableDurationHours).toBe(3);
    expect(quote.rentalAmount).toBe(dbRates.threeHourRate); // 310
    expect(getSlabSummary(quote.pricingBreakdown)).toBe('3 Hours');
  });

  // TEST 3: Duration = 3 hours -> Expected slab = 3 hours.
  test('TEST 3: Duration = 3 hours -> Expected slab = 3 hours', () => {
    const quote = PricingService.calculateRentalPrice({
      actualDurationHours: 3,
      ...dbRates,
    });
    expect(quote.actualDurationHours).toBe(3);
    expect(quote.billableDurationHours).toBe(3);
    expect(quote.rentalAmount).toBe(dbRates.threeHourRate); // 310
    expect(getSlabSummary(quote.pricingBreakdown)).toBe('3 Hours');
  });

  // TEST 4: Duration = 12 hours -> Expected slab = 12 hours (EXAMPLE C).
  test('TEST 4: Duration = 12 hours -> Expected slab = 12 hours (EXAMPLE C)', () => {
    const quote = PricingService.calculateRentalPrice({
      actualDurationHours: 12,
      ...dbRates,
    });
    expect(quote.actualDurationHours).toBe(12);
    expect(quote.billableDurationHours).toBe(12);
    expect(quote.rentalAmount).toBe(dbRates.twelveHourRate); // 1100
    expect(getSlabSummary(quote.pricingBreakdown)).toBe('12 Hours');
  });

  // TEST 5: Duration = 15 hours -> Expected slabs = 12 hours + 3 hours (EXAMPLE D).
  test('TEST 5: Duration = 15 hours -> Expected slabs = 12 hours + 3 hours (EXAMPLE D)', () => {
    const quote = PricingService.calculateRentalPrice({
      actualDurationHours: 15,
      ...dbRates,
    });
    expect(quote.actualDurationHours).toBe(15);
    expect(quote.billableDurationHours).toBe(15);
    expect(quote.rentalAmount).toBe(dbRates.twelveHourRate + dbRates.threeHourRate); // 1100 + 310 = 1410
    expect(getSlabSummary(quote.pricingBreakdown)).toBe('12 Hours + 3 Hours');
  });

  // TEST 6: Duration = 17 hours -> Expected slabs = 12 hours + 3 hours + 1 hour + 1 hour (EXAMPLE B).
  test('TEST 6: Duration = 17 hours -> Expected slabs = 12 hours + 3 hours + 1 hour + 1 hour (EXAMPLE B)', () => {
    const quote = PricingService.calculateRentalPrice({
      actualDurationHours: 17,
      ...dbRates,
    });
    expect(quote.actualDurationHours).toBe(17);
    expect(quote.billableDurationHours).toBe(17);
    expect(quote.rentalAmount).toBe(
      dbRates.twelveHourRate + dbRates.threeHourRate + dbRates.hourlyRate + dbRates.hourlyRate
    ); // 1100 + 310 + 120 + 120 = 1650
    expect(getSlabSummary(quote.pricingBreakdown)).toBe('12 Hours + 3 Hours + 1 Hour + 1 Hour');
  });

  // TEST 7: Duration = 1 day + 18 hours -> Expected slabs = 1 day + 12 hours + 6 hours (EXAMPLE A).
  test('TEST 7: Duration = 1 day + 18 hours -> Expected slabs = 1 day + 12 hours + 6 hours (EXAMPLE A)', () => {
    const totalHours = 24 + 18; // 42 hours
    const quote = PricingService.calculateRentalPrice({
      actualDurationHours: totalHours,
      ...dbRates,
    });
    expect(quote.actualDurationHours).toBe(42);
    expect(quote.billableDurationHours).toBe(42);
    expect(quote.rentalAmount).toBe(
      dbRates.dailyRate + dbRates.twelveHourRate + dbRates.sixHourRate
    ); // 1950 + 1100 + 580 = 3630
    expect(getSlabSummary(quote.pricingBreakdown)).toBe('1 Day + 12 Hours + 6 Hours');
  });

  // TEST 8: Verify the selected slab prices are fetched from the existing database pricing configuration rather than hardcoded values.
  test('TEST 8: Verify selected slab prices are fetched dynamically from vehicle db rates without hardcoding', () => {
    // Custom database record for Vehicle X
    const customDbVehicle = {
      id: 'veh-custom-99',
      price_per_hour: 155,
      price_3_hours: 420,
      price_6_hours: 790,
      price_12_hours: 1450,
      price_per_day: 2600,
      security_deposit: 1500,
    };

    const rates = PricingService.extractVehicleRates(customDbVehicle);
    expect(rates.hourlyRate).toBe(155);
    expect(rates.threeHourRate).toBe(420);
    expect(rates.sixHourRate).toBe(790);
    expect(rates.twelveHourRate).toBe(1450);
    expect(rates.dailyRate).toBe(2600);

    // 1-hour booking uses custom vehicle's price_3_hours (420)
    const quote1h = PricingService.calculateRentalPrice({
      actualDurationHours: 1,
      ...rates,
    });
    expect(quote1h.rentalAmount).toBe(420);

    // 15-hour booking uses custom vehicle's 12h + 3h (1450 + 420 = 1870)
    const quote15h = PricingService.calculateRentalPrice({
      actualDurationHours: 15,
      ...rates,
    });
    expect(quote15h.rentalAmount).toBe(1870);
  });

  // TEST 9: Verify existing additional charges and fees remain unchanged.
  test('TEST 9: Verify existing additional charges and fees remain unchanged', async () => {
    const vehicle = {
      id: '11111111-2222-3333-4444-555555555555',
      category: 'BIKE',
      price_per_hour: 100,
      price_3_hours: 250,
      price_6_hours: 450,
      price_12_hours: 800,
      price_per_day: 1400,
      security_deposit: 1000,
    };

    const quote = await pricingService.calculateQuote({
      vehicle,
      rentalType: 'HOURLY',
      startAt: '2026-10-10T10:00:00Z',
      endAt: '2026-10-10T12:00:00Z', // 2 hours -> charges 3h price (250)
      customerId: 'cust-1',
    });

    expect(quote.actualDurationHours).toBe(2);
    expect(quote.billableDurationHours).toBe(3);
    expect(quote.rentalAmount).toBe(250);
    expect(quote.bookingAmount).toBe(250);
    expect(quote.securityDeposit).toBe(1000);
    expect(quote.breakdown.convenienceFee).toBeDefined();
    expect(quote.breakdown.serviceCharge).toBeDefined();
    expect(quote.breakdown.gst).toBeDefined();
    expect(quote.breakdown.platformFee).toBeDefined();
    // Payable amount = subtotal + fees + GST (excludes security deposit as per online booking rules)
    const expectedPayable = Math.round((250 + quote.convenienceFee + quote.serviceCharge + quote.gst) * 100) / 100;
    expect(quote.payableAmount).toBe(expectedPayable);
  });

  // TEST 10: Verify the booking amount saved in the database is consistent with the corrected rental calculation.
  test('TEST 10: Verify the booking amount saved in the database is consistent with corrected rental calculation', () => {
    const vehicle = {
      id: 'veh-repo-1',
      price_per_hour: 100,
      price_3_hours: 250,
      price_6_hours: 450,
      price_12_hours: 800,
      price_per_day: 1400,
      security_deposit: 500,
    };

    const start = new Date('2026-10-10T10:00:00Z');
    const end = new Date('2026-10-10T11:00:00Z'); // 1 hour

    const pricing = bookingService.constructor.calculatePricing(vehicle, 'HOURLY', start, end);
    expect(pricing.baseAmount).toBe(250); // 3h minimum charge
    expect(pricing.rentalAmount).toBe(250);
    expect(pricing.totalAmount).toBe(250 + 500); // baseAmount + securityDeposit
    expect(pricing.billableDurationHours).toBe(3);
    expect(pricing.actualDurationHours).toBe(1);
  });

  // TEST 11: Verify the Cashfree order amount remains consistent with the existing final payable amount calculation.
  test('TEST 11: Cashfree order payable amount matches final payable amount with minimum 3-hour charge', async () => {
    const vehicle = {
      id: 'veh-cashfree-1',
      category: 'BIKE',
      price_per_hour: 100,
      price_3_hours: 250,
      price_6_hours: 450,
      price_12_hours: 800,
      price_per_day: 1400,
      security_deposit: 0,
    };

    const quote = await pricingService.calculateQuote({
      vehicle,
      rentalType: 'HOURLY',
      startAt: '2026-10-10T10:00:00Z',
      endAt: '2026-10-10T11:00:00Z', // 1 hour -> charges 3h price (250)
      customerId: 'cust-1',
    });

    const payableAmount = quote.payableAmount;
    expect(payableAmount).toBeGreaterThanOrEqual(250);
    expect(quote.totalAmount).toBe(payableAmount);
  });

  // TEST 12: Verify payment countdown and automatic booking cancellation continue to work as before.
  test('TEST 12: Verify payment countdown and automatic booking cancellation continue to work as before', async () => {
    const now = new Date('2026-10-21T10:00:00.000Z');
    const cutoff = new Date('2026-10-21T09:55:00.000Z');

    const mockClient = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql.includes('BEGIN') || sql.includes('COMMIT')) return Promise.resolve();
        if (sql.includes('SKIP LOCKED')) {
          return Promise.resolve({
            rows: [{
              booking_id: 'b-timeout-1',
              booking_number: 'BK-101',
              vehicle_id: 'v-101',
              payment_id: null,
              provider_order_id: null,
              payment_expires_at: cutoff.toISOString(),
            }],
          });
        }
        if (sql.includes('SELECT 1 FROM payments')) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('UPDATE bookings')) {
          return Promise.resolve({ rowCount: 1 });
        }
        if (sql.includes('UPDATE vehicles')) {
          return Promise.resolve({ rowCount: 1 });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };

    const mockDb = {
      connect: jest.fn().mockResolvedValue(mockClient),
      query: jest.fn().mockResolvedValue({ rows: [] }),
    };

    const timeoutService = new PaymentTimeoutService.PaymentTimeoutService({
      pool: mockDb,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      cutoffMinutes: 5,
    });

    const result = await timeoutService.processExpiredPaymentBookings(now);
    expect(result.cancelled.length).toBe(1);
    expect(result.cancelled[0].id).toBe('b-timeout-1');
    expect(result.cancelled[0].reason).toBe('PAYMENT_TIMEOUT');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE vehicles'),
      expect.any(Array)
    );
  });
});
