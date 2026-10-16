'use strict';

const { BadRequestError } = require('../errors');
const { PAYMENT_ERROR_CODES } = require('../constants/payment');

const FORBIDDEN_PAYMENT_FIELDS = new Set([
  'amount',
  'orderAmount',
  'order_amount',
  'payableAmount',
  'payable_amount',
  'subtotal',
  'discount',
  'discountAmount',
  'discount_amount',
  'couponDiscount',
  'coupon_discount',
  'couponId',
  'coupon_id',
  'currency',
  'status',
  'paymentStatus',
  'payment_status',
  'provider',
  'providerOrderId',
  'provider_order_id',
  'providerPaymentId',
  'provider_payment_id',
  'id',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
]);

const FORBIDDEN_SETTLEMENT_FIELDS = new Set([
  ...FORBIDDEN_PAYMENT_FIELDS,
  'total',
  'lateFee',
  'late_fee',
  'extraKmFee',
  'extra_km_fee',
  'damage',
  'damageEstimate',
  'damage_estimate',
  'commission',
  'payout',
  'wallet',
]);

/**
 * Validates request payload for initiating payment: POST /api/v1/bookings/:bookingId/payment
 * Strictly rejects any client attempts to inject price, currency, or payment status.
 */
function validateInitiatePayment(req, res, next) {
  const { body } = req;

  if (body && typeof body === 'object') {
    const keys = Object.keys(body);
    const forbidden = keys.filter((k) => FORBIDDEN_PAYMENT_FIELDS.has(k));
    if (forbidden.length > 0) {
      return next(new BadRequestError(
        `Field(s) not allowed in payment initiation: ${forbidden.join(', ')}`,
        'VALIDATION_ERROR',
      ));
    }
  }

  // Idempotency-Key header check
  const rawIdempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];
  if (rawIdempotencyKey) {
    const trimmed = String(rawIdempotencyKey).trim();
    if (trimmed.length > 255) {
      return next(new BadRequestError(
        'Idempotency-Key header cannot exceed 255 characters',
        'VALIDATION_ERROR',
      ));
    }
    req.idempotencyKey = trimmed;
  }

  return next();
}

/**
 * Validates request payload for initiating post-rental settlement payment:
 * POST /api/v1/bookings/:bookingId/settlement/payment
 * Strictly rejects any client attempts to inject charges, fees, amounts, or status.
 */
function validateInitiateSettlementPayment(req, res, next) {
  const { body } = req;

  if (body && typeof body === 'object') {
    const keys = Object.keys(body);
    const forbidden = keys.filter((k) => FORBIDDEN_SETTLEMENT_FIELDS.has(k));
    if (forbidden.length > 0) {
      return next(new BadRequestError(
        `Field(s) not allowed in settlement payment initiation: ${forbidden.join(', ')}`,
        'VALIDATION_ERROR',
      ));
    }
  }

  // Idempotency-Key header check
  const rawIdempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];
  if (rawIdempotencyKey) {
    const trimmed = String(rawIdempotencyKey).trim();
    if (trimmed.length > 255) {
      return next(new BadRequestError(
        'Idempotency-Key header cannot exceed 255 characters',
        'VALIDATION_ERROR',
      ));
    }
    req.idempotencyKey = trimmed;
  }

  return next();
}

/**
 * Validates request payload for initiating overtime payment:
 * POST /api/v1/bookings/:bookingId/overtime/payment
 * Strictly rejects any client attempts to inject charges, fees, amounts, or status.
 */
function validateInitiateOvertimePayment(req, res, next) {
  const { body } = req;

  if (body && typeof body === 'object') {
    const keys = Object.keys(body);
    const forbidden = keys.filter((k) => FORBIDDEN_SETTLEMENT_FIELDS.has(k) || FORBIDDEN_PAYMENT_FIELDS.has(k));
    if (forbidden.length > 0) {
      return next(new BadRequestError(
        `Field(s) not allowed in overtime payment initiation: ${forbidden.join(', ')}`,
        'VALIDATION_ERROR',
      ));
    }
  }

  // Idempotency-Key header check
  const rawIdempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];
  if (rawIdempotencyKey) {
    const trimmed = String(rawIdempotencyKey).trim();
    if (trimmed.length > 255) {
      return next(new BadRequestError(
        'Idempotency-Key header cannot exceed 255 characters',
        'VALIDATION_ERROR',
      ));
    }
    req.idempotencyKey = trimmed;
  }

  return next();
}

/**
 * Validates required Cashfree webhook signature headers.
 */
function validateWebhook(req, res, next) {
  const headers = req.headers || {};
  const signature = headers['x-webhook-signature'] || headers['x-signature'];
  const timestamp = headers['x-webhook-timestamp'] || headers['x-timestamp'];

  if (!signature || !timestamp) {
    return next(new BadRequestError(
      'Missing required Cashfree webhook signature headers',
      PAYMENT_ERROR_CODES.INVALID_WEBHOOK_SIGNATURE,
    ));
  }

  return next();
}

module.exports = {
  validateInitiatePayment,
  validateInitiateSettlementPayment,
  validateInitiateOvertimePayment,
  validateWebhook,
};
