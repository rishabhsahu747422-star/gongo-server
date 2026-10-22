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
   * GET /api/v1/payments/cashfree/return
   * GET /api/v1/bookings/:bookingId/payment-status
   *
   * Authoritative HTTPS browser return page and bridge for Cashfree post-checkout redirect.
   * Authoritatively reconciles status, renders clean responsive UI, and deep-links back to app.
   */
  async handlePaymentReturn(req, res, next) {
    try {
      const orderId = (req.query.order_id || req.query.orderId || req.params.bookingId || req.params.orderId || '').trim();

      if (!orderId) {
        if (req.accepts(['html', 'json']) === 'json' && !req.headers.accept?.includes('text/html')) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            message: 'order_id query parameter is required',
          });
        }
        return res.status(HTTP_STATUS.BAD_REQUEST).send(
          '<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:50px;"><h2>Missing order reference</h2><p>Please return to the GONGO app to review your booking.</p></body></html>'
        );
      }

      // 1. Authoritative lookup by providerOrderId or bookingId
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      let payment = null;
      let booking = null;
      try {
        if (UUID_RE.test(orderId)) {
          payment = await paymentService.paymentRepository.findLatestByBookingId(orderId);
        }
        if (!payment) {
          payment = await paymentService.paymentRepository.findByProviderOrderId(orderId);
        }
        if (payment?.bookingId) {
          booking = await paymentService.bookingRepository.findById(payment.bookingId);
        }
      } catch (dbErr) {
        logger.warn('Could not query payment record for return URL, rendering fallback return page', {
          orderId,
          error: dbErr.message,
        });
      }

      let currentStatus = (payment?.status || 'PENDING').toUpperCase();

      // 2. Authoritative sync with Cashfree if pending
      if (payment?.providerOrderId && (currentStatus === 'PENDING' || currentStatus === 'IN_PROGRESS')) {
        try {
          const remoteOrder = await paymentService.provider.getOrderStatus(payment.providerOrderId, {
            bookingId: payment.bookingId,
            paymentId: payment.id,
          });
          if (remoteOrder && (remoteOrder.orderStatus === 'PAID' || remoteOrder.orderStatus === 'SUCCESS')) {
            await paymentService.paymentRepository.transaction(async (client) => {
              const lockedPayment = await paymentService.paymentRepository.lockByProviderOrderId(
                payment.providerOrderId,
                client,
              );
              if (lockedPayment) {
                const lockedStatus = (lockedPayment.status || '').toLowerCase();
                if (lockedStatus !== 'paid' && lockedStatus !== 'success') {
                  await paymentService._applyPaymentSuccess(client, lockedPayment, {
                    providerOrderId: payment.providerOrderId,
                    paymentMethod: 'ONLINE',
                  });
                }
              }
            });
            currentStatus = 'SUCCESS';
          } else if (remoteOrder && (remoteOrder.orderStatus === 'FAILED' || remoteOrder.orderStatus === 'USER_DROPPED' || remoteOrder.orderStatus === 'CANCELLED')) {
            currentStatus = 'FAILED';
          }
        } catch (_) {
          // Fall back gracefully to current persisted database state
        }
      }

      // Normalize status string for display
      if (currentStatus === 'PAID') currentStatus = 'SUCCESS';

      // 3. Return JSON if requested by programmatic client
      if (req.accepts(['html', 'json']) === 'json' && !req.headers.accept?.includes('text/html')) {
        return res.status(HTTP_STATUS.OK).json({
          success: true,
          orderId,
          bookingId: payment?.bookingId || null,
          status: currentStatus,
          isPaid: currentStatus === 'SUCCESS',
          payment: payment ? withCashfreeEnvironment(payment) : null,
        });
      }

      // 4. Render secure, responsive HTML return bridge page for browser/WebView
      const bookingId = payment?.bookingId || (UUID_RE.test(orderId) ? orderId : '');
      const bookingRef = booking?.bookingReference || booking?.bookingNumber || bookingId || orderId;
      const amountStr = payment?.amount ? `₹${Number(payment.amount).toFixed(2)}` : '';
      const deepLinkUrl = `gongo://payment/result?order_id=${encodeURIComponent(orderId)}&status=${encodeURIComponent(currentStatus)}&booking_id=${encodeURIComponent(bookingId)}`;

      const isSuccess = currentStatus === 'SUCCESS';
      const isPending = currentStatus === 'PENDING' || currentStatus === 'IN_PROGRESS';

      const statusTitle = isSuccess
        ? 'Payment Successful'
        : (isPending ? 'Payment Processing' : 'Payment Incomplete');
      const statusColor = isSuccess ? '#10B981' : (isPending ? '#F59E0B' : '#EF4444');
      const statusIcon = isSuccess ? '✓' : (isPending ? '⏳' : '✕');
      const messageText = isSuccess
        ? 'Your payment was successfully received and verified. Your vehicle booking is confirmed!'
        : (isPending
          ? 'Your payment is being confirmed with the bank. Please check your booking in the app.'
          : 'Payment was not completed. You can safely retry payment from the GONGO app.');

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>GONGO — Payment Verification</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0B0F19;
      color: #F3F4F6;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: #111827;
      border: 1px solid #1F2937;
      border-radius: 24px;
      padding: 32px 24px;
      width: 100%;
      max-width: 420px;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0,0,0,0.6);
    }
    .badge {
      width: 72px;
      height: 72px;
      border-radius: 50%;
      background: rgba(16, 185, 129, 0.15);
      color: ${statusColor};
      border: 2px solid ${statusColor};
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 36px;
      font-weight: bold;
      margin: 0 auto 20px;
    }
    h1 { font-size: 22px; font-weight: 800; margin-bottom: 8px; color: #FFFFFF; }
    p.msg { font-size: 14px; color: #9CA3AF; line-height: 1.5; margin-bottom: 24px; }
    .details {
      background: #1F2937;
      border-radius: 14px;
      padding: 16px;
      margin-bottom: 24px;
      text-align: left;
      font-size: 13px;
    }
    .row { display: flex; justify-content: space-between; margin-bottom: 8px; }
    .row:last-child { margin-bottom: 0; }
    .label { color: #9CA3AF; }
    .val { font-weight: 700; color: #F9FAFB; word-break: break-all; }
    .btn {
      display: block;
      width: 100%;
      background: #2563EB;
      color: #FFFFFF;
      text-decoration: none;
      font-weight: 700;
      font-size: 15px;
      padding: 14px 20px;
      border-radius: 14px;
      margin-bottom: 12px;
      transition: background 0.2s;
    }
    .btn:hover { background: #1D4ED8; }
    .subtext { font-size: 12px; color: #6B7280; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge" style="color: ${statusColor}; border-color: ${statusColor}; background: ${isSuccess ? 'rgba(16,185,129,0.15)' : (isPending ? 'rgba(245,158,11,0.15)' : 'rgba(239,68,68,0.15)')};">
      ${statusIcon}
    </div>
    <h1>${statusTitle}</h1>
    <p class="msg">${messageText}</p>
    <div class="details">
      <div class="row">
        <span class="label">Reference:</span>
        <span class="val">${bookingRef}</span>
      </div>
      ${amountStr ? `<div class="row"><span class="label">Amount:</span><span class="val">${amountStr}</span></div>` : ''}
      <div class="row">
        <span class="label">Status:</span>
        <span class="val" style="color: ${statusColor};">${currentStatus}</span>
      </div>
    </div>
    <a href="${deepLinkUrl}" class="btn" id="return-btn">Return to GONGO App</a>
    <p class="subtext">If the app did not open automatically, tap the button above.</p>
  </div>
  <script>
    (function() {
      var target = "${deepLinkUrl}";
      try {
        window.location.href = target;
      } catch(e) {}
    })();
  </script>
</body>
</html>`;

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(HTTP_STATUS.OK).send(html);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new PaymentController();

