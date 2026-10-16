'use strict';

const express = require('express');
const bookingController = require('../controllers/booking.controller');
const paymentController = require('../controllers/payment.controller');
const authenticate = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const {
  validateCreateBooking,
  validateBookingId,
  validateCancelBooking,
  validateListBookings,
  validateCheckAvailability,
  validateSubmitRating,
} = require('../validators/booking.validator');
const {
  validateInitiatePayment,
  validateInitiateSettlementPayment,
  validateInitiateOvertimePayment,
} = require('../validators/payment.validator');

const router = express.Router();

/**
 * All booking endpoints require authentication and customer role.
 */
router.use(authenticate);
router.use(requireRole('customer'));

/**
 * @route   GET /api/v1/bookings/availability
 * @desc    Check vehicle availability for requested interval [startAt, endAt)
 * @access  Customer
 */
router.get(
  '/availability',
  validateCheckAvailability,
  (req, res, next) => bookingController.checkAvailability(req, res, next),
);

/**
 * @route   POST /api/v1/bookings
 * @desc    Create a new booking with rental pricing snapshot
 * @access  Customer
 */
router.post(
  '/',
  validateCreateBooking,
  (req, res, next) => bookingController.createBooking(req, res, next),
);

/**
 * @route   GET /api/v1/bookings
 * @desc    List authenticated customer bookings (paginated, filterable by status)
 * @access  Customer
 */
router.get(
  '/',
  validateListBookings,
  (req, res, next) => bookingController.listBookings(req, res, next),
);

/**
 * @route   GET /api/v1/bookings/:bookingId
 * @desc    Get single booking details owned by authenticated customer
 * @access  Customer
 */
router.get(
  '/:bookingId',
  validateBookingId,
  (req, res, next) => bookingController.getBookingById(req, res, next),
);

/**
 * @route   GET /api/v1/bookings/:bookingId/cancellation-preview
 * @desc    Get cancellation preview with authoritative refund calculation
 * @access  Customer
 */
router.get(
  '/:bookingId/cancellation-preview',
  validateBookingId,
  (req, res, next) => bookingController.getCancellationPreview(req, res, next),
);

/**
 * @route   POST /api/v1/bookings/:bookingId/cancel
 * @desc    Cancel an existing booking belonging to the customer
 * @access  Customer
 */
router.post(
  '/:bookingId/cancel',
  validateBookingId,
  validateCancelBooking,
  (req, res, next) => bookingController.cancelBooking(req, res, next),
);

/**
 * @route   POST /api/v1/bookings/:bookingId/payment
 * @desc    Initiate Cashfree payment order for booking
 * @access  Customer
 */
router.post(
  '/:bookingId/payment',
  validateBookingId,
  validateInitiatePayment,
  (req, res, next) => paymentController.createPaymentOrder(req, res, next),
);

/**
 * @route   GET /api/v1/bookings/:bookingId/payment
 * @desc    Get payment status for booking
 * @access  Customer
 */
router.get(
  '/:bookingId/payment',
  validateBookingId,
  (req, res, next) => paymentController.getPaymentStatus(req, res, next),
);

/**
 * @route   GET /api/v1/bookings/:bookingId/settlement
 * @desc    Get post-rental settlement details for a completed booking
 * @access  Customer
 */
router.get(
  '/:bookingId/settlement',
  validateBookingId,
  (req, res, next) => paymentController.getSettlementDetails(req, res, next),
);

/**
 * @route   POST /api/v1/bookings/:bookingId/settlement/payment
 * @desc    Initiate Cashfree payment order for post-rental settlement
 * @access  Customer
 */
router.post(
  '/:bookingId/settlement/payment',
  validateBookingId,
  validateInitiateSettlementPayment,
  (req, res, next) => paymentController.createSettlementPaymentOrder(req, res, next),
);

/**
 * @route   POST /api/v1/bookings/:bookingId/overtime/payment
 * @desc    Initiate Cashfree payment order for active rental overtime extra fare
 * @access  Customer
 */
router.post(
  '/:bookingId/overtime/payment',
  validateBookingId,
  validateInitiateOvertimePayment,
  (req, res, next) => paymentController.createOvertimePaymentOrder(req, res, next),
);

/**
 * @route   POST /api/v1/bookings/:bookingId/rating
 * @desc    Submit rating & review for completed booking
 * @access  Customer
 */
router.post(
  '/:bookingId/rating',
  validateBookingId,
  validateSubmitRating,
  (req, res, next) => bookingController.submitRating(req, res, next),
);

module.exports = router;

