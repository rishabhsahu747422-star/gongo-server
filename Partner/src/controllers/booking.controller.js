'use strict';

const bookingService = require('../services/booking.service');
const { sendSuccess } = require('../utils/response');

class BookingController {
  /**
   * GET /api/v1/partner/bookings
   */
  async getBookings(req, res, next) {
    try {
      const { partnerId } = req.user;
      const result = await bookingService.getBookings({
        partnerId,
        query: req.query,
      });
      sendSuccess(res, result, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/partner/bookings/:bookingId
   */
  async getBookingById(req, res, next) {
    try {
      const { partnerId } = req.user;
      const { bookingId } = req.params;
      const booking = await bookingService.getBookingById({
        bookingId,
        partnerId,
      });
      sendSuccess(res, booking, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/partner/bookings/:bookingId/pickup/otp
   */
  async requestPickupOtp(req, res, next) {
    try {
      const { partnerId, userId } = req.user;
      const { bookingId } = req.params;
      const result = await bookingService.requestPickupOtp({
        bookingId,
        partnerId,
        userId,
      });
      sendSuccess(res, result, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/partner/bookings/:bookingId/pickup/verify
   */
  async verifyPickup(req, res, next) {
    try {
      const { partnerId, userId } = req.user;
      const { bookingId } = req.params;
      const result = await bookingService.verifyPickupAndActivate({
        bookingId,
        partnerId,
        userId,
        payload: req.body,
      });
      sendSuccess(res, result, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/partner/bookings/:bookingId/return
   */
  async completeReturn(req, res, next) {
    try {
      const { partnerId, userId } = req.user;
      const { bookingId } = req.params;
      const result = await bookingService.completeReturnAndFinalize({
        bookingId,
        partnerId,
        userId,
        payload: req.body,
      });
      sendSuccess(res, result, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/partner/bookings/:bookingId/return
   */
  async getReturnDetails(req, res, next) {
    try {
      const { partnerId } = req.user;
      const { bookingId } = req.params;
      const result = await bookingService.getReturnDetails({
        bookingId,
        partnerId,
      });
      sendSuccess(res, result, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/partner/bookings/:bookingId/damage
   */
  async reportDamage(req, res, next) {
    try {
      const { partnerId, userId } = req.user;
      const { bookingId } = req.params;
      const result = await bookingService.reportDamage({
        bookingId,
        partnerId,
        userId,
        payload: req.body,
      });
      sendSuccess(res, result, 201);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/partner/bookings/:bookingId/damage
   */
  async getDamageReports(req, res, next) {
    try {
      const { partnerId } = req.user;
      const { bookingId } = req.params;
      const result = await bookingService.getDamageReports({
        bookingId,
        partnerId,
      });
      sendSuccess(res, result, 200);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new BookingController();
