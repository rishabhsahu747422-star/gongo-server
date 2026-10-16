'use strict';

const adminBookingService = require('../services/admin-booking.service');
const { getClientIp } = require('../middlewares/rateLimiter');
const { sendSuccess } = require('../utils/response');

class AdminBookingController {
  constructor() {
    this.listBookings = this.listBookings.bind(this);
    this.getBookingDetail = this.getBookingDetail.bind(this);
    this.updateBookingStatus = this.updateBookingStatus.bind(this);
    this.cancelBooking = this.cancelBooking.bind(this);
    this.getBookingTimeline = this.getBookingTimeline.bind(this);
    this.getBookingPayments = this.getBookingPayments.bind(this);
    this.getBookingStatusHistory = this.getBookingStatusHistory.bind(this);
    this.getBookingCustomer = this.getBookingCustomer.bind(this);
    this.getBookingPickup = this.getBookingPickup.bind(this);
    this.getBookingReturn = this.getBookingReturn.bind(this);
    this.getBookingAgreement = this.getBookingAgreement.bind(this);
    this.getBookingCommission = this.getBookingCommission.bind(this);
    this.getBookingSettlement = this.getBookingSettlement.bind(this);
    this.getBookingTracking = this.getBookingTracking.bind(this);
  }

  /**
   * Helper to build audit context from request state.
   * @private
   */
  _buildAuditContext(req, res, permission) {
    return {
      actorId: req.user ? req.user.id : 'unknown-admin',
      actorRole: req.user ? req.user.role : 'ADMIN',
      permission,
      requestId: req.id || (res.locals && res.locals.requestId) || null,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] || null,
    };
  }

  /**
   * GET /api/v1/admin/bookings
   * Lists bookings with search, filters (status, paymentStatus, customer, partner, vehicle, dates),
   * sorting, and bounded pagination.
   */
  async listBookings(req, res, next) {
    try {
      const data = await adminBookingService.listBookings(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/bookings/:id
   * Retrieves single booking detail with customer, partner, vehicle, pricing snapshot,
   * and summaries.
   */
  async getBookingDetail(req, res, next) {
    try {
      const data = await adminBookingService.getBookingDetail(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/bookings/:id/status
   * Updates booking status with canonical state transition validation, concurrency row lock,
   * and audit.
   */
  async updateBookingStatus(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'bookings.update');
      const data = await adminBookingService.updateBookingStatus(
        req.params.id,
        req.body,
        auditCtx,
      );
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/bookings/:id/cancel
   * Cancels booking atomically with reason, updates vehicle rental status, and logs audit trail.
   */
  async cancelBooking(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'bookings.cancel');
      const data = await adminBookingService.cancelBooking(
        req.params.id,
        req.body,
        auditCtx,
      );
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/bookings/:id/timeline
   * Assembles a deterministic chronological event timeline from canonical records.
   */
  async getBookingTimeline(req, res, next) {
    try {
      const data = await adminBookingService.getBookingTimeline(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/bookings/:id/payment (and /payments)
   * Retrieves financial payments for a booking.
   */
  async getBookingPayments(req, res, next) {
    try {
      const data = await adminBookingService.getBookingPayments(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/bookings/:id/status-history
   */
  async getBookingStatusHistory(req, res, next) {
    try {
      const data = await adminBookingService.getBookingStatusHistory(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/bookings/:id/customer
   */
  async getBookingCustomer(req, res, next) {
    try {
      const data = await adminBookingService.getBookingCustomer(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/bookings/:id/pickup
   */
  async getBookingPickup(req, res, next) {
    try {
      const data = await adminBookingService.getBookingPickup(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/bookings/:id/return
   */
  async getBookingReturn(req, res, next) {
    try {
      const data = await adminBookingService.getBookingReturn(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/bookings/:id/agreement
   */
  async getBookingAgreement(req, res, next) {
    try {
      const data = await adminBookingService.getBookingAgreement(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/bookings/:id/commission
   * Retrieves company commission record for a booking.
   */
  async getBookingCommission(req, res, next) {
    try {
      const data = await adminBookingService.getBookingCommission(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/bookings/:id/settlement
   * Retrieves partner earnings and settlement record for a booking.
   */
  async getBookingSettlement(req, res, next) {
    try {
      const data = await adminBookingService.getBookingSettlement(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/bookings/:id/tracking
   * Retrieves pickup, return verifications, and damage reports for a booking.
   */
  async getBookingTracking(req, res, next) {
    try {
      const data = await adminBookingService.getBookingTracking(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AdminBookingController();
