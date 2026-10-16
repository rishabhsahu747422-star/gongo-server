'use strict';

const bookingService = require('../services/booking.service');
const availabilityService = require('../services/availability.service');
const cancellationService = require('../services/cancellation.service');
const { sendSuccess } = require('../utils/response');
const { HTTP_STATUS } = require('../constants/http');

/**
 * BookingController — thin HTTP adapter for booking operations.
 *
 * All actions are strictly scoped to the authenticated customer (req.user.id).
 */
class BookingController {
  /**
   * POST /api/v1/bookings
   */
  async createBooking(req, res, next) {
    try {
      const isDevPayment = Boolean(
        req.body?.isDevPayment ||
        req.headers['x-dev-payment'] === 'true' ||
        req.headers['x-dev-payment'] === true
      );
      const { booking, isIdempotentReplay } = await bookingService.createBooking(
        req.user.id,
        { ...req.body, isDevPayment },
        req.idempotencyKey,
      );
      const status = isIdempotentReplay ? HTTP_STATUS.OK : HTTP_STATUS.CREATED;
      return sendSuccess(res, { booking }, 'Booking created successfully', status);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/bookings
   */
  async listBookings(req, res, next) {
    try {
      const result = await bookingService.listBookings(
        req.user.id,
        req.bookingListQuery,
      );
      return sendSuccess(res, result, 'Bookings retrieved successfully', HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/bookings/availability
   */
  async checkAvailability(req, res, next) {
    try {
      const result = await availabilityService.checkAvailability(
        req.availabilityQuery.vehicleId,
        req.availabilityQuery.startAt,
        req.availabilityQuery.endAt,
      );
      return sendSuccess(res, result, 'Availability checked successfully', HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/bookings/:bookingId
   */
  async getBookingById(req, res, next) {
    try {
      const booking = await bookingService.getBookingById(
        req.user.id,
        req.params.bookingId,
      );
      return sendSuccess(res, { booking }, 'Booking retrieved successfully', HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/bookings/:bookingId/cancellation-preview
   */
  async getCancellationPreview(req, res, next) {
    try {
      const data = await cancellationService.getCancellationPreview(
        req.user.id,
        req.params.bookingId,
      );
      return sendSuccess(res, data, 'Cancellation preview generated', HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/bookings/:bookingId/cancel
   */
  async cancelBooking(req, res, next) {
    try {
      const result = await cancellationService.cancelBooking(
        req.user.id,
        req.params.bookingId,
        {
          reason: req.body ? req.body.reason : null,
          upiId: req.body ? req.body.upiId : null,
        },
      );
      return sendSuccess(res, result, 'Booking cancelled successfully', HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/bookings/:bookingId/rating
   */
  async submitRating(req, res, next) {
    try {
      const result = await bookingService.submitRating(
        req.user.id,
        req.params.bookingId,
        req.ratingData,
      );
      return sendSuccess(res, result, 'Rating submitted successfully', HTTP_STATUS.CREATED);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new BookingController();

