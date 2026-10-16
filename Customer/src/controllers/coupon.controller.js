'use strict';

const couponService = require('../services/coupon.service');
const pricingService = require('../services/pricing.service');
const availabilityService = require('../services/availability.service');
const BookingRepository = require('../repositories/booking.repository');
const { sendSuccess } = require('../utils/response');
const { HTTP_STATUS } = require('../constants/http');
const { NotFoundError, BadRequestError } = require('../errors');

const bookingRepository = new BookingRepository();

/**
 * CouponController — handles customer coupon validation requests.
 */
class CouponController {
  /**
   * POST /api/v1/coupons/validate
   */
  async validate(req, res, next) {
    try {
      const {
        code,
        vehicleId,
        rentalType,
        startAt,
        endAt,
      } = req.body;

      const vehicle = await bookingRepository.findVehicleEligibility(vehicleId);
      if (!vehicle) {
        throw new NotFoundError('Vehicle not found', 'VEHICLE_NOT_FOUND');
      }
      availabilityService.assertVehicleEligibility(vehicle);

      const { baseAmount } = pricingService.constructor.calculateBaseRental(
        vehicle,
        rentalType,
        new Date(startAt),
        new Date(endAt),
      );

      const bookingContext = {
        vehicle,
        vehicleId,
        partnerId: vehicle.partner_id,
        shopId: vehicle.shop_id,
      };

      const reqMeta = {
        requestId: req.id || res.locals?.requestId || null,
      };

      const result = await couponService.validateCoupon(
        code,
        req.user.id,
        baseAmount,
        bookingContext,
        null,
        reqMeta,
      );

      return sendSuccess(res, {
        isValid: true,
        code: result.coupon.code,
        discountType: result.coupon.discount_type,
        discountValue: Number(result.coupon.discount_value),
        discountAmount: result.discountAmount,
        description: result.coupon.description || null,
      }, 'Coupon is valid', HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/coupons
   * List active public coupons for customer exploration.
   */
  async listActive(req, res, next) {
    try {
      const coupons = await couponService.listActiveCoupons();
      return sendSuccess(res, { coupons }, 'Active coupons retrieved successfully', HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new CouponController();
