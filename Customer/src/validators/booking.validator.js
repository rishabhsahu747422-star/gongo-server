'use strict';

const { BadRequestError } = require('../errors');
const {
  BOOKING_STATUS,
  RENTAL_TYPE,
  BOOKING_PAGINATION,
  DURATION_LIMITS,
} = require('../constants/booking');

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
const VALID_BOOKING_STATUSES = new Set(Object.values(BOOKING_STATUS));

const FORBIDDEN_CREATE_FIELDS = new Set([
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
  'status',
  'bookingStatus',
  'booking_status',
  'paymentStatus',
  'payment_status',
  'paidAmount',
  'paid_amount',
  'baseAmount',
  'base_amount',
  'totalAmount',
  'total_amount',
  'price',
  'pricePerHour',
  'price_per_hour',
  'pricePerDay',
  'price_per_day',
  'pricePerWeek',
  'price_per_week',
  'pricePerMonth',
  'price_per_month',
  'securityDeposit',
  'security_deposit',
  'lateFeePerHour',
  'late_fee_per_hour',
  'extraKmCharge',
  'extra_km_charge',
  'commission',
  'refund',
  'refundAmount',
  'refund_amount',
  'discountAmount',
  'discount_amount',
  'couponDiscount',
  'coupon_discount',
  'couponId',
  'coupon_id',
  'coupon_code',
  'payableAmount',
  'payable_amount',
  'subtotal',
  'taxAmount',
  'tax_amount',
  'id',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
]);

/**
 * Validates booking creation payload: POST /api/v1/bookings
 */
function validateCreateBooking(req, res, next) {
  const { body } = req;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return next(new BadRequestError('Request body must be a valid JSON object', 'VALIDATION_ERROR'));
  }

  const keys = Object.keys(body);

  // 1. Anti-tampering: check forbidden fields
  const forbidden = keys.filter((k) => FORBIDDEN_CREATE_FIELDS.has(k));
  if (forbidden.length > 0) {
    return next(new BadRequestError(
      `Field(s) not allowed in booking request: ${forbidden.join(', ')}`,
      'VALIDATION_ERROR',
    ));
  }

  // 2. vehicleId
  if (!isValidUUID(body.vehicleId)) {
    return next(new BadRequestError('vehicleId must be a valid UUID', 'VALIDATION_ERROR'));
  }

  // 3. rentalType
  if (!body.rentalType || !VALID_RENTAL_TYPES.has(body.rentalType)) {
    return next(new BadRequestError(
      `rentalType must be one of: ${[...VALID_RENTAL_TYPES].join(', ')}`,
      'VALIDATION_ERROR',
    ));
  }

  // 4. startAt & endAt
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

  // Reject bookings in the past (allow 5 min buffer for latency/drift)
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

  // Duration minimums by type
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

  // 5. pickupAddress (optional)
  if (body.pickupAddress !== undefined) {
    if (typeof body.pickupAddress !== 'string' || body.pickupAddress.trim().length === 0) {
      return next(new BadRequestError('pickupAddress must be a non-empty string', 'VALIDATION_ERROR'));
    }
    if (body.pickupAddress.length > 500) {
      return next(new BadRequestError('pickupAddress cannot exceed 500 characters', 'VALIDATION_ERROR'));
    }
    req.body.pickupAddress = body.pickupAddress.trim();
  }

  // 6. couponCode (optional)
  if (body.couponCode !== undefined) {
    if (typeof body.couponCode !== 'string' || body.couponCode.trim().length === 0) {
      return next(new BadRequestError('couponCode must be a non-empty string', 'VALIDATION_ERROR'));
    }
    const trimmedCoupon = body.couponCode.trim().toUpperCase();
    if (trimmedCoupon.length > 50) {
      return next(new BadRequestError('couponCode cannot exceed 50 characters', 'VALIDATION_ERROR'));
    }
    req.body.couponCode = trimmedCoupon;
  }

  // 7. Idempotency Key header
  const rawIdempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];
  if (rawIdempotencyKey) {
    const trimmed = String(rawIdempotencyKey).trim();
    if (trimmed.length > 255) {
      return next(new BadRequestError('Idempotency-Key header cannot exceed 255 characters', 'VALIDATION_ERROR'));
    }
    req.idempotencyKey = trimmed;
  }

  return next();
}

/**
 * Validates :bookingId parameter.
 */
function validateBookingId(req, res, next) {
  if (!isValidUUID(req.params.bookingId)) {
    return next(new BadRequestError('bookingId must be a valid UUID', 'VALIDATION_ERROR'));
  }
  return next();
}

/**
 * Validates cancellation payload: POST /api/v1/bookings/:bookingId/cancel
 */
function validateCancelBooking(req, res, next) {
  const { body } = req;
  if (body && typeof body === 'object') {
    const forbidden = ['status', 'refund', 'refundAmount', 'paymentStatus'].filter(
      (k) => Object.prototype.hasOwnProperty.call(body, k),
    );
    if (forbidden.length > 0) {
      return next(new BadRequestError(
        `Field(s) not allowed in cancellation request: ${forbidden.join(', ')}`,
        'VALIDATION_ERROR',
      ));
    }
    if (body.reason !== undefined) {
      if (typeof body.reason !== 'string') {
        return next(new BadRequestError('reason must be a string', 'VALIDATION_ERROR'));
      }
      if (body.reason.length > 500) {
        return next(new BadRequestError('reason cannot exceed 500 characters', 'VALIDATION_ERROR'));
      }
    }
    if (body.upiId !== undefined && body.upiId !== null) {
      if (typeof body.upiId !== 'string') {
        return next(new BadRequestError('upiId must be a string', 'VALIDATION_ERROR'));
      }
      req.body.upiId = body.upiId.trim();
    }
  }
  return next();
}

/**
 * Validates list customer bookings query params: GET /api/v1/bookings
 */
function validateListBookings(req, res, next) {
  const q = req.query;
  let page = BOOKING_PAGINATION.DEFAULT_PAGE;
  let limit = BOOKING_PAGINATION.DEFAULT_LIMIT;
  let status = null;

  if (q.page !== undefined) {
    const p = Number(q.page);
    if (!Number.isInteger(p) || p < 1) {
      return next(new BadRequestError('page must be a positive integer', 'VALIDATION_ERROR'));
    }
    page = p;
  }

  if (q.limit !== undefined) {
    const l = Number(q.limit);
    if (!Number.isInteger(l) || l < 1 || l > BOOKING_PAGINATION.MAX_LIMIT) {
      return next(new BadRequestError(
        `limit must be a positive integer not exceeding ${BOOKING_PAGINATION.MAX_LIMIT}`,
        'VALIDATION_ERROR',
      ));
    }
    limit = l;
  }

  if (q.status !== undefined) {
    const s = String(q.status).trim().toUpperCase();
    if (!VALID_BOOKING_STATUSES.has(s)) {
      return next(new BadRequestError(
        `status must be one of: ${[...VALID_BOOKING_STATUSES].join(', ')}`,
        'VALIDATION_ERROR',
      ));
    }
    status = s;
  }

  req.bookingListQuery = { page, limit, status };
  return next();
}

/**
 * Validates availability check query: GET /api/v1/bookings/availability
 */
function validateCheckAvailability(req, res, next) {
  const q = req.query;

  if (!isValidUUID(q.vehicleId)) {
    return next(new BadRequestError('vehicleId query parameter must be a valid UUID', 'VALIDATION_ERROR'));
  }
  if (!isValidIsoDate(q.startAt)) {
    return next(new BadRequestError('startAt query parameter must be a valid ISO-8601 string', 'VALIDATION_ERROR'));
  }
  if (!isValidIsoDate(q.endAt)) {
    return next(new BadRequestError('endAt query parameter must be a valid ISO-8601 string', 'VALIDATION_ERROR'));
  }

  const startDate = new Date(q.startAt);
  const endDate = new Date(q.endAt);

  if (startDate >= endDate) {
    return next(new BadRequestError('startAt must be strictly before endAt', 'VALIDATION_ERROR'));
  }

  req.availabilityQuery = {
    vehicleId: q.vehicleId,
    startAt: q.startAt,
    endAt: q.endAt,
  };

  return next();
}

/**
 * Validates rating submission payload: POST /api/v1/bookings/:bookingId/rating
 */
function validateSubmitRating(req, res, next) {
  const body = req.body || {};
  const { vehicleRating, partnerRating, review } = body;

  const vRating = Number(vehicleRating);
  if (!Number.isInteger(vRating) || vRating < 1 || vRating > 5) {
    return next(new BadRequestError('vehicleRating must be an integer between 1 and 5', 'VALIDATION_ERROR'));
  }

  const pRating = Number(partnerRating);
  if (!Number.isInteger(pRating) || pRating < 1 || pRating > 5) {
    return next(new BadRequestError('partnerRating must be an integer between 1 and 5', 'VALIDATION_ERROR'));
  }

  let cleanReview = null;
  if (review !== undefined && review !== null) {
    if (typeof review !== 'string') {
      return next(new BadRequestError('review must be a string', 'VALIDATION_ERROR'));
    }
    cleanReview = review.trim().slice(0, 1000) || null;
  }

  req.ratingData = {
    vehicleRating: vRating,
    partnerRating: pRating,
    review: cleanReview,
  };

  return next();
}

module.exports = {
  validateCreateBooking,
  validateBookingId,
  validateCancelBooking,
  validateListBookings,
  validateCheckAvailability,
  validateSubmitRating,
};

