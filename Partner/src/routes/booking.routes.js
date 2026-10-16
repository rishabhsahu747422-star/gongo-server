'use strict';

const express = require('express');
const bookingController = require('../controllers/booking.controller');
const paymentController = require('../controllers/payment.controller');
const { createRateLimiter } = require('../middlewares/rateLimiter');
const { idempotency } = require('../middlewares/idempotency');
const { rejectMassAssignment } = require('../middlewares/massAssignment');

const router = express.Router();

const bookingReadLimiter = createRateLimiter({
  max: 120,
  windowMs: 60 * 1000,
  prefix: 'rl:partner:bookings:read',
});

const pickupOtpLimiter = createRateLimiter({
  max: 10,
  windowMs: 60 * 1000,
  prefix: 'rl:partner:bookings:pickup:otp',
});

const pickupVerifyLimiter = createRateLimiter({
  max: 15,
  windowMs: 60 * 1000,
  prefix: 'rl:partner:bookings:pickup:verify',
});

const returnLimiter = createRateLimiter({
  max: 20,
  windowMs: 60 * 1000,
  prefix: 'rl:partner:bookings:return',
});

const damageLimiter = createRateLimiter({
  max: 20,
  windowMs: 60 * 1000,
  prefix: 'rl:partner:bookings:damage',
});

// Partner Booking Operations (Operational Visibility)
router.get(
  '/',
  bookingReadLimiter,
  (req, res, next) => bookingController.getBookings(req, res, next),
);

router.get(
  '/:bookingId',
  bookingReadLimiter,
  (req, res, next) => bookingController.getBookingById(req, res, next),
);

// Pickup OTP Dispatch
router.post(
  '/:bookingId/pickup/otp',
  pickupOtpLimiter,
  idempotency({ required: false }),
  (req, res, next) => bookingController.requestPickupOtp(req, res, next),
);

// Pickup OTP Verification & Rental Activation (Strict Handover)
router.post(
  '/:bookingId/pickup/verify',
  pickupVerifyLimiter,
  idempotency({ required: false }),
  rejectMassAssignment(),
  (req, res, next) => bookingController.verifyPickup(req, res, next),
);

// Return Verification & Booking Completion
router.post(
  '/:bookingId/return',
  returnLimiter,
  idempotency({ required: false }),
  rejectMassAssignment(),
  (req, res, next) => bookingController.completeReturn(req, res, next),
);

// Get Return Verification & Completion Summary
router.get(
  '/:bookingId/return',
  bookingReadLimiter,
  (req, res, next) => bookingController.getReturnDetails(req, res, next),
);

// Damage Reporting
router.post(
  '/:bookingId/damage',
  damageLimiter,
  idempotency({ required: false }),
  rejectMassAssignment(),
  (req, res, next) => bookingController.reportDamage(req, res, next),
);

router.get(
  '/:bookingId/damage',
  bookingReadLimiter,
  (req, res, next) => bookingController.getDamageReports(req, res, next),
);

// Return Settlement Summary & Charges Breakdown (Operational Visibility)
router.get(
  '/:bookingId/settlement',
  bookingReadLimiter,
  (req, res, next) => paymentController.getSettlement(req, res, next),
);

// Payment History Audit Trail (Operational Visibility)
router.get(
  '/:bookingId/payments',
  bookingReadLimiter,
  (req, res, next) => paymentController.getBookingPayments(req, res, next),
);

module.exports = router;
