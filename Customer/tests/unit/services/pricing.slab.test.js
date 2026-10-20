'use strict';

const pricingService = require('../../../src/services/pricing.service');
const PricingService = pricingService.constructor;

describe('Pricing Engine — Slot Combination Pricing & Verification Matrix', () => {
  // Reference rates:
  // 1 Hour = 100
  // 3 Hours = 250
  // 6 Hours = 450
  // 12 Hours = 800
  // 1 Day = 1400
  const rates = {
    hourlyRate: 100,
    threeHourRate: 250,
    sixHourRate: 450,
    twelveHourRate: 800,
    dailyRate: 1400,
  };

  /**
   * Helper to inspect slabs in breakdown
   */
  function summarizeBreakdown(breakdown) {
    return breakdown.map((item) => {
      if (item.type === '1_DAY') return '1 day';
      if (item.type === '12_HOURS') return '12h';
      if (item.type === '6_HOURS') return '6h';
      if (item.type === '3_HOURS') return '3h';
      if (item.type === '1_HOUR') return '1h';
      return item.label;
    }).join(' + ');
  }

  describe('Core Rule & Mandatory 12 Duration Test Matrix (Reference Rates)', () => {
    // 1. 1 hour
    test('1. 1 hour booking → 1h slot (100)', () => {
      const res = PricingService.calculateRentalPrice({
        actualDurationHours: 1,
        ...rates,
      });
      expect(res.actualDurationHours).toBe(1);
      expect(res.billableDurationHours).toBe(1);
      expect(res.rentalAmount).toBe(100);
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('1h');
    });

    test('2 hours booking → 1h + 1h (200)', () => {
      const res = PricingService.calculateRentalPrice({
        actualDurationHours: 2,
        ...rates,
      });
      expect(res.actualDurationHours).toBe(2);
      expect(res.billableDurationHours).toBe(2);
      expect(res.rentalAmount).toBe(200);
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('1h + 1h');
    });

    // 2. 3 hours
    test('2. 3 hours booking → 3h price (250)', () => {
      const res = PricingService.calculateRentalPrice({
        actualDurationHours: 3,
        ...rates,
      });
      expect(res.actualDurationHours).toBe(3);
      expect(res.billableDurationHours).toBe(3);
      expect(res.rentalAmount).toBe(250);
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('3h');
    });

    test('4 hours booking → 3h + 1h (350)', () => {
      const res = PricingService.calculateRentalPrice({
        actualDurationHours: 4,
        ...rates,
      });
      expect(res.actualDurationHours).toBe(4);
      expect(res.billableDurationHours).toBe(4);
      expect(res.rentalAmount).toBe(250 + 100); // 350
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('3h + 1h');
    });

    // 3. 5 hours
    test('3. 5 hours booking → 3h + 1h + 1h (450)', () => {
      const res = PricingService.calculateRentalPrice({
        actualDurationHours: 5,
        ...rates,
      });
      expect(res.actualDurationHours).toBe(5);
      expect(res.billableDurationHours).toBe(5);
      expect(res.rentalAmount).toBe(250 + 100 + 100); // 450
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('3h + 1h + 1h');
    });

    // 4. 6 hours
    test('4. 6 hours booking → 6h price (450)', () => {
      const res = PricingService.calculateRentalPrice({
        actualDurationHours: 6,
        ...rates,
      });
      expect(res.actualDurationHours).toBe(6);
      expect(res.billableDurationHours).toBe(6);
      expect(res.rentalAmount).toBe(450);
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('6h');
    });

    // 5. 7 hours
    test('5. 7 hours booking → 6h + 1h (550)', () => {
      const res = PricingService.calculateRentalPrice({
        actualDurationHours: 7,
        ...rates,
      });
      expect(res.actualDurationHours).toBe(7);
      expect(res.billableDurationHours).toBe(7);
      expect(res.rentalAmount).toBe(450 + 100); // 550
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('6h + 1h');
    });

    test('8 hours booking → 6h + 1h + 1h (650)', () => {
      const res = PricingService.calculateRentalPrice({
        actualDurationHours: 8,
        ...rates,
      });
      expect(res.actualDurationHours).toBe(8);
      expect(res.billableDurationHours).toBe(8);
      expect(res.rentalAmount).toBe(450 + 100 + 100); // 650
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('6h + 1h + 1h');
    });

    test('9 hours booking → 6h + 3h (700)', () => {
      const res = PricingService.calculateRentalPrice({
        actualDurationHours: 9,
        ...rates,
      });
      expect(res.actualDurationHours).toBe(9);
      expect(res.billableDurationHours).toBe(9);
      expect(res.rentalAmount).toBe(450 + 250); // 700
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('6h + 3h');
    });

    // 6. 10 hours
    test('6. 10 hours booking → 6h + 3h + 1h (800)', () => {
      const res = PricingService.calculateRentalPrice({
        actualDurationHours: 10,
        ...rates,
      });
      expect(res.actualDurationHours).toBe(10);
      expect(res.billableDurationHours).toBe(10);
      expect(res.rentalAmount).toBe(450 + 250 + 100); // 800
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('6h + 3h + 1h');
    });

    test('11 hours booking → 6h + 3h + 1h + 1h (900)', () => {
      const res = PricingService.calculateRentalPrice({
        actualDurationHours: 11,
        ...rates,
      });
      expect(res.actualDurationHours).toBe(11);
      expect(res.billableDurationHours).toBe(11);
      expect(res.rentalAmount).toBe(450 + 250 + 100 + 100); // 900
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('6h + 3h + 1h + 1h');
    });

    // 7. 12 hours
    test('7. 12 hours booking → 12h price (800)', () => {
      const res = PricingService.calculateRentalPrice({
        actualDurationHours: 12,
        ...rates,
      });
      expect(res.actualDurationHours).toBe(12);
      expect(res.billableDurationHours).toBe(12);
      expect(res.rentalAmount).toBe(800);
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('12h');
    });

    test('13 hours booking → 12h + 1h (900)', () => {
      const res = PricingService.calculateRentalPrice({
        actualDurationHours: 13,
        ...rates,
      });
      expect(res.actualDurationHours).toBe(13);
      expect(res.billableDurationHours).toBe(13);
      expect(res.rentalAmount).toBe(800 + 100); // 900
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('12h + 1h');
    });

    test('14 hours booking → 12h + 1h + 1h (1000)', () => {
      const res = PricingService.calculateRentalPrice({
        actualDurationHours: 14,
        ...rates,
      });
      expect(res.actualDurationHours).toBe(14);
      expect(res.billableDurationHours).toBe(14);
      expect(res.rentalAmount).toBe(800 + 100 + 100); // 1000
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('12h + 1h + 1h');
    });

    // 8. 15 hours
    test('8. 15 hours booking → 12h + 3h (1050)', () => {
      const res = PricingService.calculateRentalPrice({
        actualDurationHours: 15,
        ...rates,
      });
      expect(res.actualDurationHours).toBe(15);
      expect(res.billableDurationHours).toBe(15);
      expect(res.rentalAmount).toBe(800 + 250); // 1050
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('12h + 3h');
    });

    test('18 hours booking → 12h + 6h (1250)', () => {
      const res = PricingService.calculateRentalPrice({
        actualDurationHours: 18,
        ...rates,
      });
      expect(res.actualDurationHours).toBe(18);
      expect(res.billableDurationHours).toBe(18);
      expect(res.rentalAmount).toBe(800 + 450); // 1250
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('12h + 6h');
    });

    test('20 hours booking → 12h + 6h + 1h + 1h (1450)', () => {
      const res = PricingService.calculateRentalPrice({
        actualDurationHours: 20,
        ...rates,
      });
      expect(res.actualDurationHours).toBe(20);
      expect(res.billableDurationHours).toBe(20);
      expect(res.rentalAmount).toBe(800 + 450 + 100 + 100); // 1450
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('12h + 6h + 1h + 1h');
    });

    // 9. 22 hours
    test('9. 22 hours booking → 12h + 6h + 3h + 1h (1600)', () => {
      const res = PricingService.calculateRentalPrice({
        actualDurationHours: 22,
        ...rates,
      });
      expect(res.actualDurationHours).toBe(22);
      expect(res.billableDurationHours).toBe(22);
      expect(res.rentalAmount).toBe(800 + 450 + 250 + 100); // 1600
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('12h + 6h + 3h + 1h');
    });

    // 10. 24 hours
    test('10. 24 hours booking → 1 day price (1400)', () => {
      const res = PricingService.calculateRentalPrice({
        actualDurationHours: 24,
        ...rates,
      });
      expect(res.actualDurationHours).toBe(24);
      expect(res.billableDurationHours).toBe(24);
      expect(res.rentalAmount).toBe(1400);
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('1 day');
    });

    test('25 hours booking → 1 day + 1h (1500)', () => {
      const res = PricingService.calculateRentalPrice({
        actualDurationHours: 25,
        ...rates,
      });
      expect(res.actualDurationHours).toBe(25);
      expect(res.billableDurationHours).toBe(25);
      expect(res.rentalAmount).toBe(1400 + 100); // 1500
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('1 day + 1h');
    });

    // 11. 28 hours
    test('11. 28 hours booking → 1 day + 3h + 1h (1750)', () => {
      const res = PricingService.calculateRentalPrice({
        actualDurationHours: 28,
        ...rates,
      });
      expect(res.actualDurationHours).toBe(28);
      expect(res.billableDurationHours).toBe(28);
      expect(res.rentalAmount).toBe(1400 + 250 + 100); // 1750
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('1 day + 3h + 1h');
    });

    // 12. Multiple days plus additional hours
    test('12. Multiple days: 50 hours (2 days + 2 hours) → 1 day + 1 day + 1h + 1h (3000)', () => {
      const res = PricingService.calculateRentalPrice({
        actualDurationHours: 50,
        ...rates,
      });
      expect(res.actualDurationHours).toBe(50);
      expect(res.billableDurationHours).toBe(50);
      expect(res.rentalAmount).toBe(1400 * 2 + 100 * 2); // 3000
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('1 day + 1 day + 1h + 1h');
    });

    test('12b. Multiple days: 75 hours (3 days + 3 hours) → 1 day + 1 day + 1 day + 3h (4450)', () => {
      const res = PricingService.calculateRentalPrice({
        actualDurationHours: 75,
        ...rates,
      });
      expect(res.actualDurationHours).toBe(75);
      expect(res.billableDurationHours).toBe(75);
      expect(res.rentalAmount).toBe(1400 * 3 + 250); // 4450
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('1 day + 1 day + 1 day + 3h');
    });
  });

  describe('Independent Slot Pricing Verification (Different, Non-Multiple Prices)', () => {
    // Completely independent non-multiple prices across all five slots:
    // 1 Hour: 120
    // 3 Hours: 320 (320 != 3 * 120 = 360)
    // 6 Hours: 610 (610 != 6 * 120 = 720)
    // 12 Hours: 1150 (1150 != 12 * 120 = 1440)
    // 1 Day: 2100 (2100 != 24 * 120 = 2880)
    const independentRates = {
      hourlyRate: 120,
      threeHourRate: 320,
      sixHourRate: 610,
      twelveHourRate: 1150,
      dailyRate: 2100,
    };

    test('1 hour uses independently configured price (120)', () => {
      const res = PricingService.calculateRentalPrice({ actualDurationHours: 1, ...independentRates });
      expect(res.rentalAmount).toBe(120);
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('1h');
    });

    test('3 hours uses independently configured price (320, not 360)', () => {
      const res = PricingService.calculateRentalPrice({ actualDurationHours: 3, ...independentRates });
      expect(res.rentalAmount).toBe(320);
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('3h');
    });

    test('5 hours uses 3h (320) + 1h (120) + 1h (120) = 560', () => {
      const res = PricingService.calculateRentalPrice({ actualDurationHours: 5, ...independentRates });
      expect(res.rentalAmount).toBe(320 + 120 + 120); // 560
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('3h + 1h + 1h');
    });

    test('6 hours uses independently configured price (610, not 720)', () => {
      const res = PricingService.calculateRentalPrice({ actualDurationHours: 6, ...independentRates });
      expect(res.rentalAmount).toBe(610);
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('6h');
    });

    test('7 hours uses 6h (610) + 1h (120) = 730', () => {
      const res = PricingService.calculateRentalPrice({ actualDurationHours: 7, ...independentRates });
      expect(res.rentalAmount).toBe(610 + 120); // 730
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('6h + 1h');
    });

    test('10 hours uses 6h (610) + 3h (320) + 1h (120) = 1050', () => {
      const res = PricingService.calculateRentalPrice({ actualDurationHours: 10, ...independentRates });
      expect(res.rentalAmount).toBe(610 + 320 + 120); // 1050
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('6h + 3h + 1h');
    });

    test('12 hours uses independently configured price (1150, not 1440)', () => {
      const res = PricingService.calculateRentalPrice({ actualDurationHours: 12, ...independentRates });
      expect(res.rentalAmount).toBe(1150);
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('12h');
    });

    test('15 hours uses 12h (1150) + 3h (320) = 1470', () => {
      const res = PricingService.calculateRentalPrice({ actualDurationHours: 15, ...independentRates });
      expect(res.rentalAmount).toBe(1150 + 320); // 1470
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('12h + 3h');
    });

    test('22 hours uses 12h (1150) + 6h (610) + 3h (320) + 1h (120) = 2200', () => {
      const res = PricingService.calculateRentalPrice({ actualDurationHours: 22, ...independentRates });
      expect(res.rentalAmount).toBe(1150 + 610 + 320 + 120); // 2200
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('12h + 6h + 3h + 1h');
    });

    test('24 hours uses independently configured price (2100, not 2880)', () => {
      const res = PricingService.calculateRentalPrice({ actualDurationHours: 24, ...independentRates });
      expect(res.rentalAmount).toBe(2100);
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('1 day');
    });

    test('28 hours uses 1 day (2100) + 3h (320) + 1h (120) = 2540', () => {
      const res = PricingService.calculateRentalPrice({ actualDurationHours: 28, ...independentRates });
      expect(res.rentalAmount).toBe(2100 + 320 + 120); // 2540
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('1 day + 3h + 1h');
    });

    test('50 hours uses 2 days (4200) + 2x 1h (240) = 4440', () => {
      const res = PricingService.calculateRentalPrice({ actualDurationHours: 50, ...independentRates });
      expect(res.rentalAmount).toBe(2100 * 2 + 120 * 2); // 4440
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('1 day + 1 day + 1h + 1h');
    });
  });

  describe('Slot Assignment & Fallback Rules', () => {
    test('Uses configured duration slot according to deterministic business policy', () => {
      // 1h = 50, 3h = 200
      const res = PricingService.calculateRentalPrice({
        actualDurationHours: 3,
        hourlyRate: 50,
        threeHourRate: 200,
        sixHourRate: 500,
        twelveHourRate: 1000,
        dailyRate: 2000,
      });
      // 3-hour duration uses the 3h slot as defined by business rules
      expect(res.rentalAmount).toBe(200);
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('3h');
    });

    test('Prefers fewer slots when prices are equal (tie-break)', () => {
      // 1h = 100, 3h = 300 (equal price for 3 hours: 300)
      const res = PricingService.calculateRentalPrice({
        actualDurationHours: 3,
        hourlyRate: 100,
        threeHourRate: 300,
        sixHourRate: 600,
        twelveHourRate: 1200,
        dailyRate: 2400,
      });
      // Should prefer 1x 3h slot (1 slot) over 3x 1h slots (3 slots)
      expect(res.rentalAmount).toBe(300);
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('3h');
    });

    test('Handles missing intermediate slots safely without crashing', () => {
      // 3h, 6h, 12h are not configured (null)
      const res = PricingService.calculateRentalPrice({
        actualDurationHours: 5,
        hourlyRate: 100,
        threeHourRate: null,
        sixHourRate: null,
        twelveHourRate: null,
        dailyRate: 1500,
      });
      // Falls back to available slots (5x 1h) safely
      expect(res.rentalAmount).toBe(500);
      expect(res.actualDurationHours).toBe(5);
      expect(res.billableDurationHours).toBe(5);
    });
  });

  describe('Cross-Midnight Rental Duration Calculations', () => {
    const mockVehicle = {
      price_per_hour: 100,
      price_per_day: 1400,
      price_3_hours: 250,
      price_6_hours: 450,
      price_12_hours: 800,
      security_deposit: 1000,
    };

    test('11 PM → 2 AM next day = 3 hours → 3-hour price (₹250)', () => {
      const startAt = new Date('2026-10-10T23:00:00Z');
      const endAt = new Date('2026-10-11T02:00:00Z');
      const res = PricingService.calculateBaseRental(mockVehicle, 'HOURLY', startAt, endAt);

      expect(res.actualDurationHours).toBe(3);
      expect(res.billableDurationHours).toBe(3);
      expect(res.baseAmount).toBe(250);
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('3h');
    });

    test('11 PM → 1 AM next day = 2 hours → 1h + 1h price (₹200)', () => {
      const startAt = new Date('2026-10-10T23:00:00Z');
      const endAt = new Date('2026-10-11T01:00:00Z');
      const res = PricingService.calculateBaseRental(mockVehicle, 'HOURLY', startAt, endAt);

      expect(res.actualDurationHours).toBe(2);
      expect(res.billableDurationHours).toBe(2);
      expect(res.baseAmount).toBe(200);
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('1h + 1h');
    });

    test('11 PM → 6 AM next day = 7 hours → 6-hour + 1-hour price (₹550)', () => {
      const startAt = new Date('2026-10-10T23:00:00Z');
      const endAt = new Date('2026-10-11T06:00:00Z');
      const res = PricingService.calculateBaseRental(mockVehicle, 'HOURLY', startAt, endAt);

      expect(res.actualDurationHours).toBe(7);
      expect(res.billableDurationHours).toBe(7);
      expect(res.baseAmount).toBe(550);
      expect(summarizeBreakdown(res.pricingBreakdown)).toBe('6h + 1h');
    });
  });

  describe('Vehicle Rates Resolution & Real Data Mapping', () => {
    test('extracts explicit dedicated slab rates if present', () => {
      const vehicle = {
        price_per_hour: 80,
        price_per_day: 1200,
        price_3_hours: 220,
        price_6_hours: 400,
        price_12_hours: 750,
      };
      const extracted = PricingService.extractVehicleRates(vehicle);
      expect(extracted.hourlyRate).toBe(80);
      expect(extracted.threeHourRate).toBe(220);
      expect(extracted.sixHourRate).toBe(400);
      expect(extracted.twelveHourRate).toBe(750);
      expect(extracted.dailyRate).toBe(1200);
    });

    test('computes dedicated slabs from hourlyRate when dedicated columns are missing', () => {
      const vehicle = {
        price_per_hour: 50,
        price_per_day: 400,
      };
      const extracted = PricingService.extractVehicleRates(vehicle);
      expect(extracted.hourlyRate).toBe(50);
      expect(extracted.threeHourRate).toBe(150);
      expect(extracted.sixHourRate).toBe(300);
      expect(extracted.twelveHourRate).toBe(600);
      expect(extracted.dailyRate).toBe(400);
    });
  });

  describe('Commercial Quote Generation & Security Deposit Separation', () => {
    test('Quote separates security deposit from payable amount and rental amount', async () => {
      const vehicle = {
        id: '11111111-2222-3333-4444-555555555555',
        price_per_hour: 100,
        price_per_day: 1400,
        price_3_hours: 250,
        price_6_hours: 450,
        price_12_hours: 800,
        security_deposit: 1500,
      };

      const quote = await pricingService.calculateQuote({
        vehicle,
        rentalType: 'HOURLY',
        startAt: '2026-10-10T10:00:00Z',
        endAt: '2026-10-10T20:00:00Z', // 10 hours
        customerId: 'customer-1',
      });

      // 10 hours = 6h (450) + 3h (250) + 1h (100) = 800
      expect(quote.actualDurationHours).toBe(10);
      expect(quote.billableDurationHours).toBe(10);
      expect(quote.rentalAmount).toBe(800);
      expect(quote.rates.securityDeposit).toBe(1500);

      // Security deposit is NOT added to payableAmount (online payment covers rental only)
      expect(quote.breakdown.baseAmount).toBe(800);
      expect(quote.breakdown.rentalAmount).toBe(800);
      expect(quote.breakdown.securityDeposit).toBe(1500);
      expect(quote.breakdown.payableAmount).toBe(800);
      expect(quote.breakdown.totalAmount).toBe(800 + 1500); // 2300 includes deposit in total accounting breakdown
    });

    test('Quote accurately calculates 1 hour rental without minimum charge inflation', async () => {
      const vehicle = {
        id: '11111111-2222-3333-4444-555555555555',
        price_per_hour: 100,
        price_per_day: 1400,
        price_3_hours: 250,
        security_deposit: 500,
      };

      const quote = await pricingService.calculateQuote({
        vehicle,
        rentalType: 'HOURLY',
        startAt: '2026-10-10T10:00:00Z',
        endAt: '2026-10-10T11:00:00Z', // 1 hour
        customerId: 'customer-1',
      });

      expect(quote.actualDurationHours).toBe(1);
      expect(quote.billableDurationHours).toBe(1);
      expect(quote.rentalAmount).toBe(100);
      expect(quote.breakdown.payableAmount).toBe(100);
      expect(quote.pricingBreakdown[0].type).toBe('1_HOUR');
    });
  });
});
