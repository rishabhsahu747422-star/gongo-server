'use strict';

const { BadRequestError } = require('../errors');
const { RENTAL_TYPE } = require('../constants/booking');

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

const FORBIDDEN_COUPON_FIELDS = new Set([
  'customerId',
  'customer_id',
  'userId',
  'user_id',
  'partnerId',
  'partner_id',
  'discountAmount',
  'discount_amount',
  'totalAmount',
  'total_amount',
  'baseAmount',
  'base_amount',
  'commission',
]);

function validateCouponCheck(req, res, next) {
  const { body } = req;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return next(new BadRequestError('Request body must be a valid JSON object', 'VALIDATION_ERROR'));
  }

  const keys = Object.keys(body);
  const forbidden = keys.filter((k) => FORBIDDEN_COUPON_FIELDS.has(k));
  if (forbidden.length > 0) {
    return next(new BadRequestError(
      `Field(s) not allowed in coupon request: ${forbidden.join(', ')}`,
      'VALIDATION_ERROR',
    ));
  }

  if (!body.code || typeof body.code !== 'string' || body.code.trim().length === 0) {
    return next(new BadRequestError('Coupon code is required', 'VALIDATION_ERROR'));
  }
  if (body.code.trim().length > 50) {
    return next(new BadRequestError('Coupon code cannot exceed 50 characters', 'VALIDATION_ERROR'));
  }
  req.body.code = body.code.trim().toUpperCase();

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

  return next();
}

module.exports = {
  validateCouponCheck,
};
