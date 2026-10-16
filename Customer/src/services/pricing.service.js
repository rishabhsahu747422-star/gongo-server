'use strict';

const couponService = require('./coupon.service');
const platformFeeService = require('./platform-fee.service');
const { resolveVehicleCategory } = require('../utils/vehicle-category');
const { RENTAL_TYPE } = require('../constants/booking');
const { BadRequestError } = require('../errors');
const { roundMoney, clampMoney } = require('../utils/money');

/**
 * PricingService — authoritative server-side pricing engine for vehicle rentals.
 *
 * Client prices are NEVER trusted. All calculations use server-side vehicle rates.
 */
class PricingService {
  /**
   * Authoritatively extracts or derives pricing rates from a vehicle record.
   * Conceptually maps: hourlyRate, threeHourRate, sixHourRate, twelveHourRate, dailyRate, weeklyRate, monthlyRate.
   *
   * @param {object} vehicle
   * @returns {{
   *   hourlyRate: number,
   *   threeHourRate: number,
   *   sixHourRate: number,
   *   twelveHourRate: number,
   *   dailyRate: number,
   *   weeklyRate: number,
   *   monthlyRate: number
   * }}
   */
  static extractVehicleRates(vehicle) {
    const hourlyRate = vehicle.price_per_hour !== null && vehicle.price_per_hour !== undefined
      ? Number(vehicle.price_per_hour)
      : (vehicle.pricePerHour !== null && vehicle.pricePerHour !== undefined
        ? Number(vehicle.pricePerHour)
        : (vehicle.price_per_day ? Number(vehicle.price_per_day) / 24 : (vehicle.pricePerDay ? Number(vehicle.pricePerDay) / 24 : (vehicle.priceHourly ? Number(vehicle.priceHourly) : 0))));

    const dailyRate = vehicle.price_per_day !== null && vehicle.price_per_day !== undefined
      ? Number(vehicle.price_per_day)
      : (vehicle.pricePerDay !== null && vehicle.pricePerDay !== undefined
        ? Number(vehicle.pricePerDay)
        : (vehicle.priceDaily ? Number(vehicle.priceDaily) : roundMoney(hourlyRate * 24)));

    const threeHourRate = vehicle.price_3_hours !== null && vehicle.price_3_hours !== undefined
      ? Number(vehicle.price_3_hours)
      : (vehicle.price3Hours !== null && vehicle.price3Hours !== undefined
        ? Number(vehicle.price3Hours)
        : roundMoney(hourlyRate * 3));

    const sixHourRate = vehicle.price_6_hours !== null && vehicle.price_6_hours !== undefined
      ? Number(vehicle.price_6_hours)
      : (vehicle.price6Hours !== null && vehicle.price6Hours !== undefined
        ? Number(vehicle.price6Hours)
        : roundMoney(hourlyRate * 6));

    const twelveHourRate = vehicle.price_12_hours !== null && vehicle.price_12_hours !== undefined
      ? Number(vehicle.price_12_hours)
      : (vehicle.price12Hours !== null && vehicle.price12Hours !== undefined
        ? Number(vehicle.price12Hours)
        : roundMoney(hourlyRate * 12));

    const weeklyRate = vehicle.price_per_week !== null && vehicle.price_per_week !== undefined
      ? Number(vehicle.price_per_week)
      : (vehicle.priceWeekly ? Number(vehicle.priceWeekly) : roundMoney(dailyRate * 7));

    const monthlyRate = vehicle.price_per_month !== null && vehicle.price_per_month !== undefined
      ? Number(vehicle.price_per_month)
      : (vehicle.priceMonthly ? Number(vehicle.priceMonthly) : roundMoney(dailyRate * 30));

    return {
      hourlyRate,
      threeHourRate,
      sixHourRate,
      twelveHourRate,
      dailyRate,
      weeklyRate,
      monthlyRate,
    };
  }

  /**
   * Deterministic slab combination pricing algorithm.
   *
   * Available pricing slabs:
   *   1 Hour   (hourlyRate)
   *   3 Hours  (threeHourRate)
   *   6 Hours  (sixHourRate)
   *   12 Hours (twelveHourRate)
   *   1 Day    (dailyRate)
   *
   * Hierarchy:
   *   1 Day -> 12 Hours -> 6 Hours -> 3 Hours -> 1 Hour
   *
   * Rules:
   *   - 1–2 hours → minimum 3-hour price (billable: 3, actual: 1 or 2)
   *   - 3 hours   → 3-hour price
   *   - 4–5 hours → 3-hour price + remaining 1-hour slabs
   *   - 6 hours   → 6-hour price
   *   - 7–8 hours → 6-hour price + remaining 1-hour slabs
   *   - 9–11 hours → 6-hour + 3-hour + remaining 1-hour slabs
   *   - 12 hours  → 12-hour price
   *   - 13–14 hours → 12-hour + remaining 1-hour slabs
   *   - 15–17 hours → 12-hour + 3-hour + remaining 1-hour slabs
   *   - 18–23 hours → 12-hour + 6-hour + 3-hour + remaining 1-hour slabs
   *   - 24 hours  → 1-day price
   *   - >24 hours → 1-day slabs + remaining duration slabs
   *
   * @param {object} params
   * @param {number} params.actualDurationHours
   * @param {number} params.hourlyRate
   * @param {number} params.threeHourRate
   * @param {number} params.sixHourRate
   * @param {number} params.twelveHourRate
   * @param {number} params.dailyRate
   * @returns {{
   *   actualDurationHours: number,
   *   billableDurationHours: number,
   *   pricingBreakdown: Array<{type: string, label: string, hours: number, amount: number, isMinimumCharge?: boolean}>,
   *   rentalAmount: number
   * }}
   */
  static calculateRentalPrice({
    actualDurationHours,
    hourlyRate,
    threeHourRate,
    sixHourRate,
    twelveHourRate,
    dailyRate,
  }) {
    const actualHours = Math.max(1, Math.round(actualDurationHours));
    const hRate = roundMoney(hourlyRate || 0);
    const dRate = roundMoney(dailyRate || roundMoney(hRate * 24));
    const rate3h = roundMoney(threeHourRate !== undefined && threeHourRate !== null ? threeHourRate : hRate * 3);
    const rate6h = roundMoney(sixHourRate !== undefined && sixHourRate !== null ? sixHourRate : hRate * 6);
    const rate12h = roundMoney(twelveHourRate !== undefined && twelveHourRate !== null ? twelveHourRate : hRate * 12);

    // Rule: 1–2 hours minimum 3-hour price
    if (actualHours < 3) {
      return {
        actualDurationHours: actualHours,
        billableDurationHours: 3,
        rentalAmount: rate3h,
        pricingBreakdown: [
          {
            type: '3_HOURS',
            label: '3 Hours',
            hours: 3,
            amount: rate3h,
            isMinimumCharge: true,
          },
        ],
      };
    }

    const pricingBreakdown = [];
    let rentalAmount = 0;
    let remaining = actualHours;

    // 1. Daily slabs (>= 24 hours)
    const days = Math.floor(remaining / 24);
    if (days > 0) {
      for (let i = 0; i < days; i++) {
        pricingBreakdown.push({
          type: '1_DAY',
          label: '1 Day',
          hours: 24,
          amount: dRate,
        });
        rentalAmount = roundMoney(rentalAmount + dRate);
      }
      remaining %= 24;
    }

    // 2. 12-hour slab
    if (remaining >= 12) {
      pricingBreakdown.push({
        type: '12_HOURS',
        label: '12 Hours',
        hours: 12,
        amount: rate12h,
      });
      rentalAmount = roundMoney(rentalAmount + rate12h);
      remaining -= 12;
    }

    // 3. 6-hour slab
    if (remaining >= 6) {
      pricingBreakdown.push({
        type: '6_HOURS',
        label: '6 Hours',
        hours: 6,
        amount: rate6h,
      });
      rentalAmount = roundMoney(rentalAmount + rate6h);
      remaining -= 6;
    }

    // 4. 3-hour slab
    if (remaining >= 3) {
      pricingBreakdown.push({
        type: '3_HOURS',
        label: '3 Hours',
        hours: 3,
        amount: rate3h,
      });
      rentalAmount = roundMoney(rentalAmount + rate3h);
      remaining -= 3;
    }

    // 5. Remaining 1-hour slabs
    while (remaining > 0) {
      pricingBreakdown.push({
        type: '1_HOUR',
        label: '1 Hour',
        hours: 1,
        amount: hRate,
      });
      rentalAmount = roundMoney(rentalAmount + hRate);
      remaining -= 1;
    }

    return {
      actualDurationHours: actualHours,
      billableDurationHours: actualHours,
      pricingBreakdown,
      rentalAmount: roundMoney(rentalAmount),
    };
  }

  /**
   * Calculates base rental price from vehicle rates and rental duration.
   *
   * @param {object} vehicle - Authoritative vehicle record
   * @param {string} rentalType - HOURLY, DAILY, WEEKLY, MONTHLY
   * @param {Date} startDate
   * @param {Date} endDate
   * @returns {{
   *   baseAmount: number,
   *   rentalAmount: number,
   *   unit: string,
   *   count: number,
   *   diffMs: number,
   *   actualDurationHours: number,
   *   billableDurationHours: number,
   *   pricingBreakdown: Array,
   *   rates: object
   * }}
   */
  static calculateBaseRental(vehicle, rentalType, startDate, endDate) {
    const diffMs = endDate.getTime() - startDate.getTime();
    if (diffMs <= 0) {
      throw new BadRequestError('Rental end time must be after start time', 'VALIDATION_ERROR');
    }

    const rates = PricingService.extractVehicleRates(vehicle);
    const actualDurationHours = Math.ceil(diffMs / (1000 * 60 * 60)) || 1;

    let baseAmount = 0;
    let count = actualDurationHours;
    let unit = 'hours';
    let billableDurationHours = actualDurationHours;
    let pricingBreakdown = [];

    if (rentalType === RENTAL_TYPE.WEEKLY) {
      count = Math.ceil(diffMs / (1000 * 60 * 60 * 24 * 7)) || 1;
      unit = 'weeks';
      baseAmount = roundMoney(rates.weeklyRate * count);
      billableDurationHours = count * 7 * 24;
      pricingBreakdown = [{
        type: 'WEEKLY',
        label: count === 1 ? '1 Week' : `${count} Weeks`,
        hours: count * 168,
        amount: baseAmount,
      }];
    } else if (rentalType === RENTAL_TYPE.MONTHLY) {
      count = Math.ceil(diffMs / (1000 * 60 * 60 * 24 * 30)) || 1;
      unit = 'months';
      baseAmount = roundMoney(rates.monthlyRate * count);
      billableDurationHours = count * 30 * 24;
      pricingBreakdown = [{
        type: 'MONTHLY',
        label: count === 1 ? '1 Month' : `${count} Months`,
        hours: count * 720,
        amount: baseAmount,
      }];
    } else if (rentalType === RENTAL_TYPE.DAILY) {
      count = Math.ceil(diffMs / (1000 * 60 * 60 * 24)) || 1;
      unit = 'days';
      const slabResult = PricingService.calculateRentalPrice({
        actualDurationHours,
        hourlyRate: rates.hourlyRate,
        threeHourRate: rates.threeHourRate,
        sixHourRate: rates.sixHourRate,
        twelveHourRate: rates.twelveHourRate,
        dailyRate: rates.dailyRate,
      });

      baseAmount = slabResult.rentalAmount;
      billableDurationHours = slabResult.billableDurationHours;
      pricingBreakdown = slabResult.pricingBreakdown;
    } else if (rentalType === RENTAL_TYPE.HOURLY || !rentalType) {
      const slabResult = PricingService.calculateRentalPrice({
        actualDurationHours,
        hourlyRate: rates.hourlyRate,
        threeHourRate: rates.threeHourRate,
        sixHourRate: rates.sixHourRate,
        twelveHourRate: rates.twelveHourRate,
        dailyRate: rates.dailyRate,
      });

      baseAmount = slabResult.rentalAmount;
      count = slabResult.actualDurationHours;
      unit = slabResult.actualDurationHours === 1 ? 'hour' : 'hours';
      billableDurationHours = slabResult.billableDurationHours;
      pricingBreakdown = slabResult.pricingBreakdown;
    } else {
      throw new BadRequestError(`Invalid rentalType: ${rentalType}`, 'VALIDATION_ERROR');
    }

    return {
      baseAmount: clampMoney(baseAmount),
      rentalAmount: clampMoney(baseAmount),
      unit,
      count,
      diffMs,
      actualDurationHours,
      billableDurationHours,
      pricingBreakdown,
      rates,
    };
  }

  /**
   * Generates a complete commercial pricing quote.
   *
   * @param {object} params
   * @param {object} params.vehicle
   * @param {string} params.rentalType
   * @param {string|Date} params.startAt
   * @param {string|Date} params.endAt
   * @param {string} [params.customerId]
   * @param {string|null} [params.couponCode]
   * @returns {Promise<object>}
   */
  async calculateQuote({
    vehicle,
    rentalType,
    startAt,
    endAt,
    customerId,
    couponCode = null,
  }) {
    const startDate = new Date(startAt);
    const endDate = new Date(endAt);

    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      throw new BadRequestError('Invalid startAt or endAt timestamp', 'VALIDATION_ERROR');
    }
    if (startDate >= endDate) {
      throw new BadRequestError('startAt must be strictly before endAt', 'VALIDATION_ERROR');
    }

    const {
      baseAmount,
      unit,
      count,
      diffMs,
      actualDurationHours,
      billableDurationHours,
      pricingBreakdown,
      rates,
    } = PricingService.calculateBaseRental(
      vehicle,
      rentalType,
      startDate,
      endDate,
    );

    const securityDeposit = clampMoney(vehicle.security_deposit || 0);

    let discountAmount = 0;
    let appliedCoupon = null;

    if (couponCode) {
      const evaluation = await couponService.validateCoupon(
        couponCode,
        customerId,
        baseAmount,
        {
          vehicle,
          vehicleId: vehicle.id,
          partnerId: vehicle.partner_id,
          shopId: vehicle.shop_id,
        },
      );
      discountAmount = evaluation.discountAmount;
      appliedCoupon = {
        code: evaluation.coupon.code,
        discountType: evaluation.coupon.discount_type,
        discountValue: Number(evaluation.coupon.discount_value),
        discountAmount,
      };
    }

    const subtotal = clampMoney(baseAmount - discountAmount);

    const vehicleCategory = resolveVehicleCategory(vehicle);
    let feeCharges = {
      convenienceFee: 0,
      serviceCharge: 0,
      gst: 0,
      platformFee: 0,
      totalFeesAndTax: 0,
    };
    try {
      feeCharges = await platformFeeService.calculateChargesForRental(subtotal, null, { vehicleCategory });
    } catch {
      // Fallback if platform fee service fails
    }

    const convenienceFee = feeCharges.convenienceFee;
    const serviceCharge = feeCharges.serviceCharge;
    const gstAmount = feeCharges.gst;
    const platformFee = feeCharges.platformFee;

    // Online booking payment covers rental, convenience fee, service charge, and GST (excludes separate pickup deposit)
    const payableAmount = roundMoney(subtotal + convenienceFee + serviceCharge + gstAmount);
    const totalAmount = payableAmount;

    return {
      actualDurationHours,
      billableDurationHours,
      rentalAmount: baseAmount,
      bookingAmount: baseAmount,
      convenienceFee,
      serviceCharge,
      gst: gstAmount,
      taxes: gstAmount,
      taxAmount: gstAmount,
      platformFee,
      totalAmount,
      payableAmount,
      securityDeposit,
      pricingBreakdown,
      rentalType,
      duration: {
        diffMs,
        unit,
        count,
        actualDurationHours,
        billableDurationHours,
      },
      rates: {
        pricePerHour: rates.hourlyRate !== null && rates.hourlyRate !== undefined
          ? rates.hourlyRate
          : null,
        price3Hours: rates.threeHourRate !== null && rates.threeHourRate !== undefined
          ? rates.threeHourRate
          : null,
        price6Hours: rates.sixHourRate !== null && rates.sixHourRate !== undefined
          ? rates.sixHourRate
          : null,
        price12Hours: rates.twelveHourRate !== null && rates.twelveHourRate !== undefined
          ? rates.twelveHourRate
          : null,
        pricePerDay: rates.dailyRate !== null && rates.dailyRate !== undefined
          ? rates.dailyRate
          : null,
        pricePerWeek: rates.weeklyRate !== null && rates.weeklyRate !== undefined
          ? rates.weeklyRate
          : null,
        pricePerMonth: rates.monthlyRate !== null && rates.monthlyRate !== undefined
          ? rates.monthlyRate
          : null,
        price_per_hour: rates.hourlyRate,
        price_3_hours: rates.threeHourRate,
        price_6_hours: rates.sixHourRate,
        price_12_hours: rates.twelveHourRate,
        price_per_day: rates.dailyRate,
        securityDeposit,
        lateFeePerHour: clampMoney(vehicle.late_fee_per_hour || 0),
        extraKmCharge: clampMoney(vehicle.extra_km_charge || 0),
      },
      breakdown: {
        baseAmount,
        rentalAmount: baseAmount,
        bookingAmount: baseAmount,
        actualDurationHours,
        billableDurationHours,
        pricingBreakdown,
        discountAmount,
        couponDiscount: discountAmount,
        securityDeposit,
        subtotal,
        convenienceFee,
        serviceCharge,
        gst: gstAmount,
        taxes: gstAmount,
        taxAmount: gstAmount,
        platformFee,
        totalAmount: roundMoney(subtotal + securityDeposit),
        payableAmount,
      },
      appliedCoupon,
    };
  }
}

module.exports = new PricingService();
