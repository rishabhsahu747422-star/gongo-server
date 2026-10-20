'use strict';

const paymentService = require('../services/payment.service');
const { sendSuccess } = require('../utils/response');
const { HTTP_STATUS } = require('../constants/http');
const { ForbiddenError } = require('../errors');

/**
 * PaymentController — HTTP adapter for payment initiation, status, and webhook handling.
 */
/**
 * Attaches the backend's Cashfree mode so clients launch checkout in the matching
 * environment instead of guessing from their own build configuration.
 *
 * @param {object} payment
 * @returns {object}
 */
const withCashfreeEnvironment = (payment) => (payment && typeof payment === 'object'
  ? { ...payment, cashfreeEnvironment: paymentService.provider?.envMode || null }
  : payment);

class PaymentController {
  /**
   * POST /api/v1/bookings/:bookingId/payment
   * Initiates payment order for a booking.
   */
  async createPaymentOrder(req, res, next) {
    try {
      const { bookingId } = req.params;
      const { payment, isIdempotentReplay } = await paymentService.initiatePayment(
        req.user.id,
        bookingId,
        req.idempotencyKey,
      );

      const status = isIdempotentReplay ? HTTP_STATUS.OK : HTTP_STATUS.CREATED;
      return sendSuccess(res, { payment: withCashfreeEnvironment(payment) }, 'Payment order created successfully', status);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/bookings/:bookingId/payment
   * Retrieves payment status for a booking.
   */
  async getPaymentStatus(req, res, next) {
    try {
      const { bookingId } = req.params;
      const payment = await paymentService.getPaymentStatus(req.user.id, bookingId);
      return sendSuccess(res, { payment }, 'Payment status retrieved successfully', HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/bookings/:bookingId/overtime/payment
   * Initiates Cashfree payment order for active rental overtime dues.
   */
  async createOvertimePaymentOrder(req, res, next) {
    try {
      const { bookingId } = req.params;
      const { payment, isIdempotentReplay } = await paymentService.initiateOvertimePayment(
        req.user.id,
        bookingId,
        req.idempotencyKey,
      );

      const status = isIdempotentReplay ? HTTP_STATUS.OK : HTTP_STATUS.CREATED;
      return sendSuccess(res, { payment: withCashfreeEnvironment(payment) }, 'Overtime payment order created successfully', status);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/bookings/:bookingId/settlement/payment
   * Initiates Cashfree payment order for post-rental settlement charges.
   */
  async createSettlementPaymentOrder(req, res, next) {
    try {
      const { bookingId } = req.params;
      const { payment, isIdempotentReplay } = await paymentService.initiateSettlementPayment(
        req.user.id,
        bookingId,
        req.idempotencyKey,
      );

      const status = isIdempotentReplay ? HTTP_STATUS.OK : HTTP_STATUS.CREATED;
      return sendSuccess(res, { payment: withCashfreeEnvironment(payment) }, 'Settlement payment order created successfully', status);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/bookings/:bookingId/settlement
   * Retrieves post-rental settlement information for a completed booking.
   */
  async getSettlementDetails(req, res, next) {
    try {
      const { bookingId } = req.params;
      const result = await paymentService.getSettlementDetails(req.user.id, bookingId);
      return sendSuccess(res, result, 'Settlement details retrieved successfully', HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/payments/webhook/cashfree
   * Receives and processes verified Cashfree webhook callbacks.
   */
  async handleCashfreeWebhook(req, res, next) {
    try {
      const result = await paymentService.processWebhook(
        req.headers,
        req.rawBody,
        req.body,
      );
      return sendSuccess(res, result, 'Webhook processed successfully', HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/payments/test/simulate-webhook
   * Sandbox-only test simulation helper.
   */
  async simulateTestWebhook(req, res, next) {
    try {
      if (process.env.NODE_ENV === 'production' || String(paymentService.provider?.envMode).toUpperCase() === 'PRODUCTION') {
        throw new ForbiddenError('Test webhook simulation is not permitted in production', 'SIMULATION_FORBIDDEN_IN_PRODUCTION');
      }
      const { bookingId, orderId, paymentStatus = 'SUCCESS' } = req.body;
      const result = await paymentService.simulateCashfreeWebhook({
        customerId: req.user.id,
        bookingId,
        orderId,
        paymentStatus,
      });
      return sendSuccess(res, result, 'Test webhook simulated successfully', HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/payments/dev-bypass
   * Development bypass: marks booking as paid and confirmed without real gateway interaction.
   */
  async devBypassPayment(req, res, next) {
    try {
      if (process.env.NODE_ENV === 'production' || String(paymentService.provider?.envMode).toUpperCase() === 'PRODUCTION') {
        throw new ForbiddenError('Payment dev bypass is strictly disabled in production', 'BYPASS_FORBIDDEN_IN_PRODUCTION');
      }
      const { bookingId } = req.body;
      if (!bookingId) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          message: 'bookingId is required for dev bypass payment',
        });
      }
      const result = await paymentService.devBypassPayment(req.user.id, bookingId);
      return sendSuccess(res, result, 'Dev payment bypass successful', HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/payments/cashfree/create-order
   * Direct Cashfree create-order endpoint accepting { bookingId } in request body.
   */
  async createCashfreeOrder(req, res, next) {
    try {
      const bookingId = req.body?.bookingId || req.params?.bookingId;
      if (!bookingId) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          message: 'bookingId is required to create payment order',
        });
      }
      const { payment, isIdempotentReplay } = await paymentService.initiatePayment(
        req.user.id,
        bookingId,
        req.idempotencyKey,
      );

      const status = isIdempotentReplay ? HTTP_STATUS.OK : HTTP_STATUS.CREATED;
      const cashfreeEnv = paymentService.provider?.envMode || 'SANDBOX';
      return sendSuccess(res, {
        orderId: payment.providerOrderId || payment.id,
        paymentSessionId: payment.paymentSessionId || payment.metadata?.paymentSessionId,
        amount: payment.amount,
        currency: payment.currency || 'INR',
        payment: withCashfreeEnvironment(payment),
        cashfreeEnvironment: cashfreeEnv,
        environment: cashfreeEnv,
      }, 'Payment order created successfully', status);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/payments/cashfree/:orderId/status
   * Direct Cashfree get-order-status endpoint accepting orderId or bookingId.
   */
  async getCashfreeOrderStatus(req, res, next) {
    try {
      const orderOrBookingId = req.params.orderId || req.params.bookingId;
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      let bookingId = orderOrBookingId;
      if (!UUID_RE.test(orderOrBookingId)) {
        const paymentRecord = await paymentService.paymentRepository.findByProviderOrderId(orderOrBookingId);
        if (paymentRecord) {
          bookingId = paymentRecord.bookingId;
        }
      }
      const payment = await paymentService.getPaymentStatus(req.user.id, bookingId);
      return sendSuccess(res, { payment: withCashfreeEnvironment(payment) }, 'Payment status retrieved successfully', HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new PaymentController();

