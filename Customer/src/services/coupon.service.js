'use strict';

const CouponRepository = require('../repositories/coupon.repository');
const { DISCOUNT_TYPE, COUPON_ERROR_CODES } = require('../constants/pricing');
const { BadRequestError, NotFoundError } = require('../errors');
const { roundMoney, clampMoney } = require('../utils/money');
const logger = require('../config/logger');

/**
 * CouponService handles coupon validation, discount computation,
 * and concurrency-safe redemption execution.
 */
class CouponService {
  constructor() {
    this.couponRepository = new CouponRepository();
    this.couponLocks = new Map();
  }

  /**
   * Serializes in-flight operations for the same coupon in this process,
   * complementing SELECT FOR UPDATE database row locking.
   *
   * @param {string} codeOrId
   * @param {Function} fn
   * @returns {Promise<any>}
   */
  async withCouponLock(codeOrId, fn) {
    if (!codeOrId) return fn();
    const key = String(codeOrId).trim().toUpperCase();
    const previous = this.couponLocks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.couponLocks.set(key, current);

    try {
      await previous;
      return await fn();
    } finally {
      release();
      if (this.couponLocks.get(key) === current) {
        this.couponLocks.delete(key);
      }
    }
  }

  /**
   * Internal coupon rule evaluator.
   *
   * @param {object} coupon
   * @param {string} customerId
   * @param {number} eligibleAmount
   * @param {object|null} [bookingContext]
   * @param {object} [client]
   * @param {object} [reqMeta]
   * @returns {Promise<{coupon: object, discountAmount: number}>}
   */
  async _evaluateCoupon(coupon, customerId, eligibleAmount, bookingContext = null, client = null, reqMeta = {}) {
    const requestId = reqMeta.requestId || null;
    const code = coupon.code;

    logger.info('[COUPON] Coupon validation started', {
      requestId,
      couponCode: code,
      customerId,
      eligibleAmount,
    });

    const now = new Date();

    if (!coupon.is_active) {
      logger.warn('[COUPON] Coupon validation failed - Inactive', {
        requestId,
        couponCode: code,
        customerId,
        reason: 'Coupon is not active',
      });
      throw new BadRequestError('This coupon is currently inactive', COUPON_ERROR_CODES.COUPON_NOT_ACTIVE);
    }

    const validFrom = coupon.valid_from ? new Date(coupon.valid_from) : null;
    const validUntil = coupon.valid_until ? new Date(coupon.valid_until) : null;

    if (validFrom && now < validFrom) {
      logger.warn('[COUPON] Coupon validation failed - Not yet active', {
        requestId,
        couponCode: code,
        customerId,
        reason: 'Coupon is not yet active',
      });
      throw new BadRequestError('This coupon is currently inactive', COUPON_ERROR_CODES.COUPON_NOT_ACTIVE);
    }
    if (validUntil && now > validUntil) {
      logger.warn('[COUPON] Coupon validation failed - Expired', {
        requestId,
        couponCode: code,
        customerId,
        reason: 'Coupon has expired',
      });
      throw new BadRequestError('This coupon has expired', COUPON_ERROR_CODES.COUPON_EXPIRED);
    }

    const minAmount = Number(coupon.min_booking_amount || 0);
    if (eligibleAmount < minAmount) {
      logger.warn('[COUPON] Coupon validation failed - Minimum booking amount not met', {
        requestId,
        couponCode: code,
        customerId,
        eligibleAmount,
        minAmount,
      });
      throw new BadRequestError(
        `Minimum booking amount of ₹${minAmount} is required for this coupon`,
        COUPON_ERROR_CODES.COUPON_MINIMUM_AMOUNT_NOT_MET,
      );
    }

    // Check platform usage limit
    if (coupon.usage_limit !== null && coupon.usage_limit !== undefined) {
      const dbUsage = coupon.id ? await this.couponRepository.getUsageCount(coupon.id, client) : 0;
      const totalRedemptions = Math.max(Number(coupon.used_count || 0), dbUsage);
      if (totalRedemptions >= Number(coupon.usage_limit)) {
        logger.warn('[COUPON] Coupon validation failed - Total usage limit reached', {
          requestId,
          couponCode: code,
          totalRedemptions,
          usageLimit: coupon.usage_limit,
        });
        throw new BadRequestError(
          'This coupon has reached its usage limit',
          COUPON_ERROR_CODES.COUPON_USAGE_LIMIT_REACHED,
        );
      }
    }

    // Check per-customer usage limit
    const customerLimit = coupon.usage_limit_per_customer !== null && coupon.usage_limit_per_customer !== undefined
      ? Number(coupon.usage_limit_per_customer)
      : (coupon.per_customer_limit !== null && coupon.per_customer_limit !== undefined
          ? Number(coupon.per_customer_limit)
          : null);

    if (customerLimit !== null && customerLimit > 0 && customerId) {
      const customerRedemptions = await this.couponRepository.getCustomerUsageCount(
        coupon.id,
        customerId,
        client,
      );
      if (customerRedemptions >= customerLimit) {
        logger.warn('[COUPON] Coupon validation failed - Customer redemption limit reached', {
          requestId,
          couponCode: code,
          customerId,
          customerRedemptions,
          customerLimit,
        });
        throw new BadRequestError(
          'You have already reached the redemption limit for this coupon',
          COUPON_ERROR_CODES.COUPON_CUSTOMER_LIMIT_REACHED,
        );
      }
    }

    // Check coupon_rules if any exist in the database
    if (bookingContext) {
      const rules = await this.couponRepository.findCouponRules(coupon.id, client);
      for (const rule of rules) {
        if (!rule.is_active) continue;
        if (rule.vehicle_id && bookingContext.vehicleId && rule.vehicle_id !== bookingContext.vehicleId) {
          throw new BadRequestError('This coupon is not applicable to the selected vehicle', COUPON_ERROR_CODES.COUPON_NOT_APPLICABLE);
        }
        if (rule.category_id && bookingContext.categoryId && rule.category_id !== bookingContext.categoryId) {
          throw new BadRequestError('This coupon is not applicable to this vehicle category', COUPON_ERROR_CODES.COUPON_NOT_APPLICABLE);
        }
        if (rule.partner_id && bookingContext.partnerId && rule.partner_id !== bookingContext.partnerId) {
          throw new BadRequestError('This coupon is not applicable to this partner', COUPON_ERROR_CODES.COUPON_NOT_APPLICABLE);
        }
        if (rule.shop_id && bookingContext.shopId && rule.shop_id !== bookingContext.shopId) {
          throw new BadRequestError('This coupon is not applicable to this shop location', COUPON_ERROR_CODES.COUPON_NOT_APPLICABLE);
        }
      }
    }

    // Calculate discount amount dynamically (case-insensitive discount_type)
    let discount = 0;
    const discountVal = Number(coupon.discount_value || 0);
    const discountType = String(coupon.discount_type || '').toUpperCase();

    if (discountType === 'PERCENTAGE') {
      discount = roundMoney(eligibleAmount * (discountVal / 100));
      if (coupon.max_discount_amount !== null && coupon.max_discount_amount !== undefined) {
        const maxDiscount = Number(coupon.max_discount_amount);
        if (discount > maxDiscount) {
          discount = maxDiscount;
        }
      }
    } else if (discountType === 'FIXED' || discountType === 'FLAT') {
      discount = roundMoney(discountVal);
    } else {
      // Fallback: If unspecified, treat as fixed amount
      discount = roundMoney(discountVal);
    }

    // Discount cannot exceed eligible amount
    discount = clampMoney(Math.min(discount, eligibleAmount));

    logger.info('[COUPON] Coupon validation succeeded', {
      requestId,
      couponCode: code,
      customerId,
      eligibleAmount,
      calculatedDiscount: discount,
      discountType,
    });

    return {
      coupon,
      discountAmount: discount,
    };
  }

  /**
   * Validates a coupon for quote calculation without acquiring database row locks.
   *
   * @param {string} couponCode
   * @param {string} customerId
   * @param {number} eligibleAmount
   * @param {object|null} [bookingContext]
   * @param {object} [client]
   * @param {object} [reqMeta]
   * @returns {Promise<{coupon: object, discountAmount: number}>}
   */
  async validateCoupon(couponCode, customerId, eligibleAmount, bookingContext = null, client = null, reqMeta = {}) {
    if (!couponCode || typeof couponCode !== 'string' || couponCode.trim().length === 0) {
      throw new BadRequestError('Coupon code is invalid', COUPON_ERROR_CODES.INVALID_COUPON);
    }

    const coupon = await this.couponRepository.findByCode(couponCode, client);
    if (!coupon) {
      logger.warn('[COUPON] Coupon validation failed - Not found', {
        couponCode,
        customerId,
      });
      throw new NotFoundError('Coupon code is invalid', COUPON_ERROR_CODES.INVALID_COUPON);
    }

    return this._evaluateCoupon(coupon, customerId, eligibleAmount, bookingContext, client, reqMeta);
  }

  /**
   * Validates a coupon inside a transaction and acquires a row lock FOR UPDATE
   * on the coupon to strictly serialize concurrent redemptions.
   *
   * @param {string} couponCode
   * @param {string} customerId
   * @param {number} eligibleAmount
   * @param {object|null} [bookingContext]
   * @param {object} client - Active transactional client
   * @param {object} [reqMeta]
   * @returns {Promise<{coupon: object, discountAmount: number}>}
   */
  async validateAndLockCoupon(couponCode, customerId, eligibleAmount, bookingContext = null, client = null, reqMeta = {}) {
    if (!couponCode || typeof couponCode !== 'string' || couponCode.trim().length === 0) {
      throw new BadRequestError('Coupon code is invalid', COUPON_ERROR_CODES.INVALID_COUPON);
    }

    const existing = await this.couponRepository.findByCode(couponCode, client);
    if (!existing) {
      throw new NotFoundError('Coupon code is invalid', COUPON_ERROR_CODES.INVALID_COUPON);
    }

    // Lock coupon row FOR UPDATE to protect usage limits against concurrent transactions
    const lockedCoupon = await this.couponRepository.lockCouponForRedemption(existing.id, client);
    if (!lockedCoupon) {
      throw new NotFoundError('Coupon code is invalid', COUPON_ERROR_CODES.INVALID_COUPON);
    }

    return this._evaluateCoupon(lockedCoupon, customerId, eligibleAmount, bookingContext, client, reqMeta);
  }

  /**
   * Retrieves active public coupons for customer exploration.
   *
   * @returns {Promise<Array>}
   */
  async listActiveCoupons() {
    return this.couponRepository.findActiveCoupons();
  }

  /**
   * Records a coupon redemption.
   *
   * @param {object} params
   * @param {string} params.couponId
   * @param {string} params.customerId
   * @param {string} [params.bookingId]
   * @param {number} params.discountAmount
   * @param {object} client
   * @returns {Promise<object>}
   */
  async recordRedemption(params, client) {
    return this.couponRepository.createRedemption(params, client);
  }
}

module.exports = new CouponService();
