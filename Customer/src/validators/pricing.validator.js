'use strict';

const { BadRequestError } = require('../errors');
const { RENTAL_TYPE, DURATION_LIMITS } = require('../constants/booking');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUUID(val) {
  return typeof val === 'string' && UUID_RE.test(val);
}

function isValidIsoDate(val) {
  if (typeof val !== 'string') return false;
  const d = new Date(val);
  return !Number.isNaN(d.getTime()) && val.includes('T');
}

const VALID_RENTAL_TYPES = new Set(Object.values(RENTAL_TYPE));

const FORBIDDEN_QUOTE_FIELDS = new Set([
  'customerId',
  'customer_id',
  'userId',
  'user_id',
  'partnerId',
  'partner_id',
  'partnerUserId',
  'partner_user_id',
  'shopId',
  'shop_id',
  'baseAmount',
  'base_amount',
  'discountAmount',
  'discount_amount',
  'couponDiscount',
  'coupon_discount',
  'totalAmount',
  'total_amount',
  'payableAmount',
  'payable_amount',
  'securityDeposit',
  'security_deposit',
  'lateFeePerHour',
  'extraKmCharge',
  'commission',
  'taxAmount',
  'tax_amount',
  'paidAmount',
]);

/**
 * Validates pricing quote request: POST /api/v1/pricing/quote
 */
function validatePricingQuote(req, res, next) {
  const { body } = req;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return next(new BadRequestError('Request body must be a valid JSON object', 'VALIDATION_ERROR'));
  }

  const keys = Object.keys(body);
  const forbidden = keys.filter((k) => FORBIDDEN_QUOTE_FIELDS.has(k));
  if (forbidden.length > 0) {
    return next(new BadRequestError(
      `Field(s) not allowed in pricing request: ${forbidden.join(', ')}`,
      'VALIDATION_ERROR',
    ));
  }

  if (!isValidUUID(body.vehicleId)) {
    return next(new BadRequestError('vehicleId must be a valid UUID', 'VALIDATION_ERROR'));
  }

  if (!body.rentalType || !VALID_RENTAL_TYPES.has(body.rentalType)) {
    return next(new BadRequestError(
      `rentalType must be one of: ${[...VALID_RENTAL_TYPES].join(', ')}`,
      'VALIDATION_ERROR',
    ));
  }

  if (!isValidIsoDate(body.startAt)) {
    return next(new BadRequestError('startAt must be a valid ISO-8601 timestamp string', 'VALIDATION_ERROR'));
  }
  if (!isValidIsoDate(body.endAt)) {
    return next(new BadRequestError('endAt must be a valid ISO-8601 timestamp string', 'VALIDATION_ERROR'));
  }

  const startDate = new Date(body.startAt);
  const endDate = new Date(body.endAt);

  if (startDate >= endDate) {
    return next(new BadRequestError('startAt must be strictly before endAt', 'VALIDATION_ERROR'));
  }

  const now = new Date(Date.now() - 5 * 60 * 1000);
  if (startDate < now) {
    return next(new BadRequestError('startAt cannot be in the past', 'VALIDATION_ERROR'));
  }

  const diffMs = endDate.getTime() - startDate.getTime();
  const maxMs = DURATION_LIMITS.MAX_RENTAL_DAYS * 24 * 60 * 60 * 1000;
  if (diffMs > maxMs) {
    return next(new BadRequestError(
      `Rental duration cannot exceed ${DURATION_LIMITS.MAX_RENTAL_DAYS} days`,
      'VALIDATION_ERROR',
    ));
  }

  // Duration minimums by rental type
  if (body.rentalType === RENTAL_TYPE.HOURLY && diffMs < 3600 * 1000) {
    return next(new BadRequestError('Hourly rental duration must be at least 1 hour', 'VALIDATION_ERROR'));
  }
  if (body.rentalType === RENTAL_TYPE.DAILY && diffMs < 24 * 3600 * 1000) {
    return next(new BadRequestError('Daily rental duration must be at least 24 hours', 'VALIDATION_ERROR'));
  }
  if (body.rentalType === RENTAL_TYPE.WEEKLY && diffMs < 7 * 24 * 3600 * 1000) {
    return next(new BadRequestError('Weekly rental duration must be at least 7 days', 'VALIDATION_ERROR'));
  }
  if (body.rentalType === RENTAL_TYPE.MONTHLY && diffMs < 30 * 24 * 3600 * 1000) {
    return next(new BadRequestError('Monthly rental duration must be at least 30 days', 'VALIDATION_ERROR'));
  }

  if (body.couponCode !== undefined && body.couponCode !== null) {
    if (typeof body.couponCode !== 'string' || body.couponCode.trim().length === 0) {
      return next(new BadRequestError('couponCode must be a non-empty string', 'VALIDATION_ERROR'));
    }
    if (body.couponCode.trim().length > 50) {
      return next(new BadRequestError('couponCode cannot exceed 50 characters', 'VALIDATION_ERROR'));
    }
    req.body.couponCode = body.couponCode.trim().toUpperCase();
  }

  return next();
}

module.exports = {
  validatePricingQuote,
};
