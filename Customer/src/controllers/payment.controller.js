'use strict';

const paymentService = require('../services/payment.service');
const { sendSuccess } = require('../utils/response');
const { HTTP_STATUS } = require('../constants/http');
const { ForbiddenError } = require('../errors');
const logger = require('../config/logger');

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

  /**
   * GET /api/v1/payments/return
   * POST /api/v1/payments/return
   * Authoritative return handler invoked after Cashfree checkout.
   * Performs backend-to-backend status inquiry, persists state, and renders
   * an HTML return bridge that deep-links back to the GONGO mobile application.
   */
  async handlePaymentReturn(req, res, next) {
    try {
      let orderId = req.query.order_id
        || req.body?.order_id
        || req.query.orderId
        || req.body?.orderId;

      const bookingIdParam = req.params?.bookingId;
      if (!orderId && bookingIdParam) {
        try {
          const paymentRecord = await paymentService.paymentRepository.findByBookingId(bookingIdParam);
          if (paymentRecord?.providerOrderId) {
            orderId = paymentRecord.providerOrderId;
          }
        } catch (_) {}
      }

      if (!orderId || typeof orderId !== 'string') {
        if (req.xhr || req.headers.accept?.includes('application/json')) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            message: 'Missing required order_id parameter',
          });
        }

        if (bookingIdParam) {
          const deepLink = `gongo://payment/result?booking_id=${encodeURIComponent(bookingIdParam)}&status=PENDING`;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.status(HTTP_STATUS.OK).send(
            PaymentController._renderReturnBridgeHtml({
              status: 'PENDING',
              title: 'Payment Status',
              message: 'Verifying payment status with Cashfree.',
              badgeColor: '#F59E0B',
              badgeText: 'PROCESSING',
              deepLink,
              orderId: '',
            }),
          );
        }

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(HTTP_STATUS.BAD_REQUEST).send(
          PaymentController._renderReturnBridgeHtml({
            status: 'ERROR',
            title: 'Missing Order Information',
            message: 'No valid order reference was received from Cashfree.',
            deepLink: 'gongo://payment/result?status=ERROR',
          }),
        );
      }

      const reconciliation = await paymentService.reconcilePaymentByProviderOrderId(orderId);
      const { status, bookingId, amount } = reconciliation;

      const deepLink = `gongo://payment/result?order_id=${encodeURIComponent(orderId)}&booking_id=${encodeURIComponent(bookingId || '')}&status=${encodeURIComponent(status || 'PENDING')}`;

      // If client explicitly requests JSON (API inquiry)
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return sendSuccess(res, {
          orderId,
          bookingId,
          status,
          isPaid: status === 'SUCCESS' || status === 'PAID',
          amount,
        }, 'Payment return processed successfully', HTTP_STATUS.OK);
      }

      let title;
      let message;
      let badgeColor;
      let badgeText;

      if (status === 'SUCCESS' || status === 'PAID') {
        title = 'Payment Confirmed! 🎉';
        message = amount
          ? `Your payment of ₹${amount} was successfully verified.`
          : 'Your payment was successfully verified.';
        badgeColor = '#10B981';
        badgeText = 'VERIFIED';
      } else if (status === 'FAILED') {
        title = 'Payment Incomplete';
        message = 'The payment was not completed or was cancelled.';
        badgeColor = '#EF4444';
        badgeText = 'FAILED';
      } else {
        title = 'Payment Processing';
        message = 'Your payment is being confirmed. Please return to the app.';
        badgeColor = '#F59E0B';
        badgeText = 'PROCESSING';
      }

      const html = PaymentController._renderReturnBridgeHtml({
        status,
        title,
        message,
        badgeColor,
        badgeText,
        deepLink,
        orderId,
      });

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(HTTP_STATUS.OK).send(html);
    } catch (err) {
      return next(err);
    }
  }

  static _escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return '';
    return unsafe
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  static _renderReturnBridgeHtml({
    title,
    message,
    badgeColor,
    badgeText,
    deepLink,
    orderId,
  }) {
    const escTitle = PaymentController._escapeHtml(title || 'GONGO Payment');
    const escMessage = PaymentController._escapeHtml(message || '');
    const escBadgeText = PaymentController._escapeHtml(badgeText || '');
    const escBadgeColor = PaymentController._escapeHtml(badgeColor || '#FFB800');
    const escOrderId = PaymentController._escapeHtml(orderId || '');
    const safeDeepLink = encodeURI(deepLink || 'gongo://');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escTitle} - GONGO</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: #0A0A0A;
      color: #FFFFFF;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background-color: #171717;
      border: 1px solid #262626;
      border-radius: 24px;
      padding: 32px 24px;
      width: 100%;
      max-width: 400px;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0,0,0,0.5);
    }
    .logo {
      font-size: 24px;
      font-weight: 900;
      letter-spacing: 2px;
      color: #FFB800;
      margin-bottom: 24px;
    }
    .badge {
      display: inline-block;
      padding: 6px 14px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.5px;
      margin-bottom: 16px;
      background-color: rgba(255, 255, 255, 0.08);
      color: ${escBadgeColor};
      border: 1px solid ${escBadgeColor};
    }
    h1 {
      font-size: 20px;
      font-weight: 800;
      margin-bottom: 10px;
      color: #FFFFFF;
    }
    p {
      font-size: 14px;
      color: #A3A3A3;
      line-height: 1.5;
      margin-bottom: 24px;
    }
    .btn {
      display: block;
      width: 100%;
      background-color: #FFB800;
      color: #000000;
      text-decoration: none;
      font-weight: 800;
      font-size: 15px;
      padding: 16px;
      border-radius: 14px;
      transition: opacity 0.2s;
    }
    .btn:active {
      opacity: 0.85;
    }
    .order-ref {
      margin-top: 20px;
      font-size: 11px;
      color: #525252;
      word-break: break-all;
    }
    .hint {
      margin-top: 14px;
      font-size: 12px;
      color: #737373;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">GONGO</div>
    ${escBadgeText ? `<div class="badge">${escBadgeText}</div>` : ''}
    <h1>${escTitle}</h1>
    <p>${escMessage}</p>
    <a href="${safeDeepLink}" class="btn" id="openAppBtn">Open GONGO App</a>
    <div class="hint">Tap above if you are not automatically redirected.</div>
    ${escOrderId ? `<div class="order-ref">Order: ${escOrderId}</div>` : ''}
  </div>
  <script>
    (function() {
      var deepLink = "${safeDeepLink}";
      if (deepLink) {
        setTimeout(function() {
          window.location.href = deepLink;
        }, 100);
      }
    })();
  </script>
</body>
</html>`;
  }
}

module.exports = new PaymentController();

