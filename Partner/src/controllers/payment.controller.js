'use strict';

const paymentService = require('../services/payment.service');
const paymentValidator = require('../validators/payment.validator');
const { sendSuccess } = require('../utils/response');
const { HTTP_STATUS } = require('../constants/http');

/**
 * PaymentController — Handles partner settlement views, payment histories,
 * and incoming Cashfree gateway webhook events.
 */
class PaymentController {
  /**
   * GET /api/v1/partner/bookings/:bookingId/settlement
   * Retrieves read-only post-rental return charges and settlement status.
   */
  async getSettlement(req, res, next) {
    try {
      const { partnerId } = req.user;
      const bookingId = paymentValidator.validateBookingId(req.params.bookingId);
      const settlement = await paymentService.getSettlementDetails(partnerId, bookingId);
      return sendSuccess(res, settlement, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/partner/bookings/:bookingId/payments
   * Retrieves complete payment history for a partner's booking.
   */
  async getBookingPayments(req, res, next) {
    try {
      const { partnerId } = req.user;
      const bookingId = paymentValidator.validateBookingId(req.params.bookingId);
      const payments = await paymentService.getBookingPayments(partnerId, bookingId);
      return sendSuccess(res, payments, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/payments/webhook/cashfree
   * Ingests, authenticates, and reconciles Cashfree PG v2023-08-01 webhook events.
   */
  async handleCashfreeWebhook(req, res, next) {
    try {
      const result = await paymentService.processCashfreeWebhook(
        req.headers,
        req.rawBody,
        req.body,
      );
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/payments/webhook/cashfree/payout
   * Ingests, authenticates, and reconciles Cashfree Payout webhook events.
   */
  async handleCashfreePayoutWebhook(req, res, next) {
    try {
      const result = await paymentService.processCashfreePayoutWebhook({
        headers: req.headers,
        rawBody: req.rawBody,
        payload: req.body,
      });
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new PaymentController();
