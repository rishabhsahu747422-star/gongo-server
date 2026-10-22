'use strict';

const crypto = require('crypto');
const PaymentProvider = require('./payment.provider');
const env = require('../../../config/env');
const logger = require('../../../config/logger');
const { ServiceUnavailableError, BadRequestError } = require('../../../errors');
const { PAYMENT_ERROR_CODES } = require('../../../constants/payment');

/**
 * CashfreeProvider — Production implementation of Cashfree Payment Gateway API (PG v2023-08-01).
 *
 * Handles order creation, status checks, and cryptographic webhook signature verification.
 * Supports mock delegate for deterministic testing.
 */
class CashfreeProvider extends PaymentProvider {
  constructor(options = {}) {
    super();
    this.appId = options.appId || env.CASHFREE_APP_ID;
    this.secretKey = options.secretKey || env.CASHFREE_SECRET_KEY;
    this.envMode = (options.env || env.CASHFREE_ENV || 'SANDBOX').toUpperCase();
    this.apiVersion = options.apiVersion || env.CASHFREE_API_VERSION || '2025-01-01';
    this.returnUrl = options.returnUrl !== undefined ? options.returnUrl : env.CASHFREE_RETURN_URL;

    this.baseUrl = this.envMode === 'PRODUCTION'
      ? 'https://api.cashfree.com/pg'
      : 'https://sandbox.cashfree.com/pg';

    this.mockDelegate = null;
    this._recent404Orders = new Map();
  }

  /**
   * Logs a concise, safe diagnostic warning for Cashfree 404 responses.
   * Suppresses repeat log flooding for the same provider order reference within 5 minutes.
   * NEVER logs secrets or credentials.
   *
   * @param {string} providerOrderId
   * @param {object} [details]
   */
  _log404Once(providerOrderId, details = {}) {
    const now = Date.now();
    const lastLogged = this._recent404Orders.get(providerOrderId);
    if (lastLogged && (now - lastLogged) < 5 * 60 * 1000) {
      return;
    }

    // Prune stale cache entries if too large
    if (this._recent404Orders.size > 1000) {
      for (const [key, timestamp] of this._recent404Orders) {
        if ((now - timestamp) > 5 * 60 * 1000) {
          this._recent404Orders.delete(key);
        }
      }
    }

    this._recent404Orders.set(providerOrderId, now);

    logger.warn('Cashfree order reference ID not found in environment (404)', {
      providerOrderId,
      envMode: this.envMode,
      statusCode: 404,
      bookingId: details.bookingId || undefined,
      paymentId: details.paymentId || undefined,
      message: details.message || 'Order Reference Id does not exist',
    });
  }

  /**
   * Allows test suites to supply a mock delegate for predictable offline assertions.
   *
   * @param {object|null} delegate
   */
  setMockDelegate(delegate) {
    this.mockDelegate = delegate;
  }

  /**
   * Internal helper for Cashfree request headers.
   * NEVER exposes secretKey in logs.
   *
   * @returns {object}
   */
  _getHeaders() {
    return {
      'x-client-id': this.appId,
      'x-client-secret': this.secretKey,
      'x-api-version': this.apiVersion,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  /**
   * Resolves and guarantees an absolute HTTPS return URL for Cashfree PG.
   * Cashfree PG strictly rejects custom application schemes (e.g. gongo://).
   *
   * @param {string} orderId
   * @param {string} [callerOverride]
   * @returns {string}
   */
  resolveReturnUrl(orderId, callerOverride) {
    let candidate = (callerOverride !== undefined && callerOverride !== null && String(callerOverride).trim() !== ''
      ? String(callerOverride)
      : (this.returnUrl || '')).trim();

    const backendBase = (process.env.BACKEND_PUBLIC_URL || env.BACKEND_PUBLIC_URL || 'https://gongo-server-myqf.onrender.com').replace(/\/+$/, '');
    const canonicalFallback = `${backendBase}/api/v1/customer/payments/cashfree/return?order_id={order_id}`;

    // Reject custom schemes (gongo://, https://gongo://, etc.) and fall back to configured or canonical URL
    if (candidate.startsWith('gongo://') || candidate.startsWith('https://gongo://') || candidate.startsWith('http://gongo://')) {
      logger.warn('[CASHFREE] Non-HTTPS return URL scheme rejected; falling back to canonical HTTPS return URL', {
        orderId,
        rejectedUrl: candidate,
      });
      candidate = (this.returnUrl && (this.returnUrl.startsWith('https://') || this.returnUrl.startsWith('http://')))
        ? this.returnUrl
        : canonicalFallback;
    }

    if (!candidate.startsWith('https://') && !candidate.startsWith('http://')) {
      if (this.returnUrl && (this.returnUrl.startsWith('https://') || this.returnUrl.startsWith('http://'))) {
        candidate = this.returnUrl;
      } else {
        throw new BadRequestError(
          'Configured return URL must be a valid absolute HTTP or HTTPS URL',
          PAYMENT_ERROR_CODES.INVALID_RETURN_URL,
        );
      }
    }

    if (candidate.includes('{order_id}')) {
      return candidate.replace('{order_id}', encodeURIComponent(orderId));
    }

    const separator = candidate.includes('?') ? '&' : '?';
    return `${candidate}${separator}order_id=${encodeURIComponent(orderId)}`;
  }

  /**
   * Sanitizes and guarantees an absolute HTTPS return URL for Cashfree PG.
   * Cashfree PG strictly rejects custom application schemes (e.g. gongo://).
   *
   * @param {string} rawUrl
   * @param {string} orderId
   * @returns {string}
   */
  sanitizeReturnUrl(rawUrl, orderId) {
    let candidate = (rawUrl || '').trim();
    const backendBase = (process.env.BACKEND_PUBLIC_URL || env.BACKEND_PUBLIC_URL || 'https://gongo-server-myqf.onrender.com').replace(/\/+$/, '');
    const canonicalFallback = `${backendBase}/api/v1/payments/return?order_id={order_id}`;

    // If empty or custom application scheme (e.g. gongo://, myapp://), replace with canonical backend HTTPS route
    if (!candidate.startsWith('https://') && !candidate.startsWith('http://')) {
      logger.warn('[CASHFREE] Non-HTTPS return URL scheme rejected; falling back to canonical HTTPS return URL', {
        orderId,
        rejectedUrl: candidate,
        fallbackUrl: canonicalFallback,
      });
      candidate = canonicalFallback;
    }

    return candidate.replace('{order_id}', encodeURIComponent(orderId));
  }

  /**
   * Sanitizes and guarantees an absolute HTTPS notify URL for Cashfree webhooks.
   *
   * @param {string} rawUrl
   * @returns {string}
   */
  sanitizeNotifyUrl(rawUrl) {
    let candidate = (rawUrl || '').trim();
    const backendBase = (process.env.BACKEND_PUBLIC_URL || env.BACKEND_PUBLIC_URL || 'https://gongo-server-myqf.onrender.com').replace(/\/+$/, '');
    if (!candidate || (!candidate.startsWith('https://') && !candidate.startsWith('http://'))) {
      return `${backendBase}/api/v1/payments/webhook/cashfree`;
    }
    return candidate;
  }

  /**
   * Initiates a payment order on Cashfree.
   *
   * @param {object} params
   * @param {string} params.orderId
   * @param {number} params.orderAmount
   * @param {string} [params.orderCurrency='INR']
   * @param {object} params.customerDetails
   * @param {string} [params.returnUrl]
   * @returns {Promise<{providerOrderId: string, paymentSessionId: string|null,
   *   orderStatus: string, cfOrderId: string|null}>}
   */
  async createOrder({
    orderId,
    orderAmount,
    orderCurrency = 'INR',
    customerDetails,
    returnUrl,
    notifyUrl,
    orderMeta,
    orderNote,
  }) {
    if (this.mockDelegate && typeof this.mockDelegate.createOrder === 'function') {
      return this.mockDelegate.createOrder({
        orderId,
        orderAmount,
        orderCurrency,
        customerDetails,
        returnUrl,
        notifyUrl,
        orderMeta,
        orderNote,
      });
    }

    if (this.envMode === 'PRODUCTION') {
      logger.info('[CASHFREE] Production order creation started', {
        orderId,
        orderAmount: Number(orderAmount),
        orderCurrency,
      });
    }

    const candidateReturnUrl = returnUrl || orderMeta?.returnUrl || orderMeta?.return_url || this.returnUrl || '';
    const resolvedReturnUrl = this.sanitizeReturnUrl(candidateReturnUrl, orderId);

    const candidateNotifyUrl = notifyUrl || orderMeta?.notifyUrl || orderMeta?.notify_url || process.env.CASHFREE_NOTIFY_URL;
    const resolvedNotifyUrl = this.sanitizeNotifyUrl(candidateNotifyUrl);

    const meta = {
      return_url: resolvedReturnUrl,
    };
    if (resolvedNotifyUrl) {
      meta.notify_url = resolvedNotifyUrl;
    }

    const payload = {
      order_id: orderId,
      order_amount: Number(orderAmount),
      order_currency: orderCurrency,
      customer_details: {
        customer_id: customerDetails.id,
        customer_email: customerDetails.email || 'customer@example.com',
        customer_phone: customerDetails.phone || '9999999999',
        customer_name: customerDetails.name || 'GONGO Customer',
      },
      order_meta: meta,
      order_note: orderNote || 'GONGO Vehicle Rental Booking',
    };

    try {
      const response = await fetch(`${this.baseUrl}/orders`, {
        method: 'POST',
        headers: this._getHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        // In PRODUCTION mode, NEVER fallback to sandbox or mock sessions under any circumstance.
        if (this.envMode === 'PRODUCTION') {
          logger.error('[CASHFREE PRODUCTION] Order creation rejected by Cashfree', {
            status: response.status,
            orderId,
            code: data.code || 'UNKNOWN',
            message: data.message || 'Payment provider rejected request',
          });
          throw new BadRequestError(
            data.message || 'Cashfree rejected payment order creation',
            PAYMENT_ERROR_CODES.PAYMENT_ORDER_CREATION_FAILED,
          );
        }

        // In explicit non-production testing, if configured for sandbox fallback
        logger.warn('[Cashfree Sandbox] Operating in Sandbox Test Mode with test payment session', {
          orderId,
          reason: data.message || data.code || 'Sandbox Test Mode',
        });
        return {
          providerOrderId: orderId,
          paymentSessionId: `session_sandbox_${orderId}_${Date.now()}`,
          orderStatus: 'ACTIVE',
          cfOrderId: `cf_sandbox_${Date.now()}`,
        };
      }

      logger.info('[CASHFREE] Order created successfully', {
        orderId: data.order_id || orderId,
        cfOrderId: data.cf_order_id ? String(data.cf_order_id) : null,
        orderStatus: data.order_status || 'ACTIVE',
        env: this.envMode,
      });

      return {
        providerOrderId: data.order_id || orderId,
        paymentSessionId: data.payment_session_id || null,
        orderStatus: data.order_status || 'ACTIVE',
        cfOrderId: data.cf_order_id ? String(data.cf_order_id) : null,
      };
    } catch (err) {
      if (this.envMode === 'PRODUCTION') {
        if (err instanceof BadRequestError) throw err;
        logger.error('[CASHFREE PRODUCTION] Network/gateway connection failure', {
          orderId,
          error: err.message,
        });
        throw new ServiceUnavailableError(
          'Payment gateway temporarily unreachable',
          PAYMENT_ERROR_CODES.PAYMENT_PROVIDER_UNAVAILABLE,
        );
      }

      logger.warn('[Cashfree Sandbox] Connection fallback in Sandbox Test Mode', { orderId, error: err.message });
      return {
        providerOrderId: orderId,
        paymentSessionId: `session_sandbox_${orderId}_${Date.now()}`,
        orderStatus: 'ACTIVE',
        cfOrderId: `cf_sandbox_${Date.now()}`,
      };
    }
  }

  /**
   * Fetches order status from Cashfree.
   *
   * @param {string} providerOrderId
   * @param {object} [metadata] Optional diagnostic context (e.g. bookingId, paymentId)
   * @returns {Promise<object>}
   */
  async getOrderStatus(providerOrderId, metadata = {}) {
    if (this.mockDelegate && typeof this.mockDelegate.getOrderStatus === 'function') {
      return this.mockDelegate.getOrderStatus(providerOrderId, metadata);
    }

    if (this.envMode === 'PRODUCTION') {
      logger.info('[CASHFREE] Payment verification started', { providerOrderId });
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/orders/${encodeURIComponent(providerOrderId)}`,
        {
          method: 'GET',
          headers: this._getHeaders(),
          signal: AbortSignal.timeout(10000),
        },
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        // Handle 404 cleanly across both PRODUCTION and SANDBOX environments
        if (response.status === 404) {
          this._log404Once(providerOrderId, {
            message: data.message,
            bookingId: metadata.bookingId,
            paymentId: metadata.paymentId,
          });
          return {
            providerOrderId,
            orderStatus: 'NOT_FOUND',
            notFound: true,
            httpStatus: 404,
            orderAmount: null,
            orderCurrency: 'INR',
          };
        }

        if (this.envMode === 'SANDBOX') {
          return {
            providerOrderId,
            orderStatus: 'ACTIVE',
            orderAmount: null,
            orderCurrency: 'INR',
          };
        }

        logger.error('Cashfree fetch order status failed', {
          status: response.status,
          providerOrderId,
          message: data.message,
        });
        throw new BadRequestError(
          data.message || 'Failed to retrieve order status from payment provider',
          PAYMENT_ERROR_CODES.PAYMENT_PROVIDER_UNAVAILABLE,
        );
      }

      if (this.envMode === 'PRODUCTION') {
        logger.info('[CASHFREE] Payment verified', {
          providerOrderId: data.order_id || providerOrderId,
          orderStatus: data.order_status,
        });
      }

      return {
        providerOrderId: data.order_id || providerOrderId,
        orderStatus: data.order_status,
        orderAmount: data.order_amount ? Number(data.order_amount) : null,
        orderCurrency: data.order_currency || 'INR',
      };
    } catch (err) {
      if (this.envMode === 'SANDBOX') {
        return {
          providerOrderId,
          orderStatus: 'ACTIVE',
          orderAmount: null,
          orderCurrency: 'INR',
        };
      }
      if (err instanceof BadRequestError) throw err;
      logger.error('Cashfree connection error during getOrderStatus', {
        providerOrderId,
        error: err.message,
      });
      throw new ServiceUnavailableError(
        'Payment gateway temporarily unreachable',
        PAYMENT_ERROR_CODES.PAYMENT_PROVIDER_UNAVAILABLE,
      );
    }
  }

  /**
   * Cryptographically verifies Cashfree webhook signature.
   *
   * Algorithm per Cashfree documentation:
   *   data = timestamp + rawBody
   *   signature = Base64(HMAC_SHA256(data, secretKey))
   *
   * @param {object} headers
   * @param {string} rawBody
   * @returns {boolean}
   */
  verifyWebhookSignature(headers, rawBody) {
    if (!headers || typeof headers !== 'object') return false;
    if (typeof rawBody !== 'string') return false;

    const timestamp = headers['x-webhook-timestamp'] || headers['x-timestamp'];
    const signature = headers['x-webhook-signature'] || headers['x-signature'];
    // No literal fallback: a publicly known key would make signatures forgeable.
    const secretKey = this.secretKey || env.CASHFREE_SECRET_KEY;

    if (!timestamp || !signature || !secretKey) {
      return false;
    }

    // Replay protection: verify timestamp is within acceptable window
    // (max 10 minutes in past, max 5 minutes into the future)
    const nowSec = Math.floor(Date.now() / 1000);
    const tsNum = Number(timestamp);
    let tsSec;
    if (!Number.isNaN(tsNum)) {
      tsSec = tsNum > 1e11 ? Math.floor(tsNum / 1000) : tsNum;
    } else {
      tsSec = Math.floor(Date.parse(timestamp) / 1000);
    }

    if (Number.isNaN(tsSec) || (nowSec - tsSec) > 600 || (tsSec - nowSec) > 300) {
      logger.warn('Cashfree webhook timestamp is outside acceptable clock skew window', {
        webhookTimestamp: timestamp,
        currentTime: nowSec,
      });
      return false;
    }

    const dataToSign = `${timestamp}${rawBody}`;
    const expectedSignature = crypto
      .createHmac('sha256', secretKey)
      .update(dataToSign)
      .digest('base64');

    const sigBuf = Buffer.from(String(signature), 'utf8');
    const expectedBuf = Buffer.from(expectedSignature, 'utf8');

    if (sigBuf.length !== expectedBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(sigBuf, expectedBuf);
  }

  /**
   * Initiates a refund on Cashfree for a previously paid order.
   *
   * @param {object} params
   * @param {string} params.orderId - Provider order ID
   * @param {number} params.refundAmount - Refund amount in INR
   * @param {string} params.refundId - Unique refund reference ID
   * @param {string} [params.refundNote] - Reason / note for refund
   * @returns {Promise<{providerRefundId: string, refundStatus: string, refundAmount: number}>}
   */
  async createRefund({ orderId, refundAmount, refundId, refundNote }) {
    if (this.mockDelegate && typeof this.mockDelegate.createRefund === 'function') {
      return this.mockDelegate.createRefund({ orderId, refundAmount, refundId, refundNote });
    }

    const payload = {
      refund_amount: Number(refundAmount),
      refund_id: refundId,
      refund_note: refundNote || 'GONGO Customer Booking Refund',
    };

    try {
      const response = await fetch(
        `${this.baseUrl}/orders/${encodeURIComponent(orderId)}/refunds`,
        {
          method: 'POST',
          headers: this._getHeaders(),
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000),
        },
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        logger.error('Cashfree refund creation failed', {
          status: response.status,
          orderId,
          refundId,
          message: data.message,
        });
        throw new BadRequestError(
          data.message || 'Payment provider rejected refund request',
        );
      }

      const providerRefundId = data.cf_refund_id
        ? String(data.cf_refund_id)
        : (data.refund_id || refundId);

      return {
        providerRefundId,
        cfRefundId: data.cf_refund_id ? String(data.cf_refund_id) : undefined,
        refundId: data.refund_id || refundId,
        refundStatus: data.refund_status || 'SUCCESS',
        refundAmount: data.refund_amount ? Number(data.refund_amount) : Number(refundAmount),
      };
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      logger.error('Cashfree connection error during createRefund', {
        orderId,
        refundId,
        error: err.message,
      });
      throw new ServiceUnavailableError('Payment gateway temporarily unreachable');
    }
  }

  /**
   * Fetches status of a refund from Cashfree.
   *
   * @param {string} orderId
   * @param {string} refundId
   * @returns {Promise<object>}
   */
  async getRefundStatus(orderId, refundId) {
    if (this.mockDelegate && typeof this.mockDelegate.getRefundStatus === 'function') {
      return this.mockDelegate.getRefundStatus(orderId, refundId);
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/orders/${encodeURIComponent(orderId)}/refunds/${encodeURIComponent(refundId)}`,
        {
          method: 'GET',
          headers: this._getHeaders(),
          signal: AbortSignal.timeout(10000),
        },
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new BadRequestError(data.message || 'Failed to retrieve refund status from Cashfree');
      }

      return {
        providerRefundId: data.cf_refund_id ? String(data.cf_refund_id) : data.refund_id,
        cfRefundId: data.cf_refund_id ? String(data.cf_refund_id) : undefined,
        refundId: data.refund_id || refundId,
        refundStatus: data.refund_status,
        refundAmount: data.refund_amount ? Number(data.refund_amount) : null,
      };
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      throw new ServiceUnavailableError('Payment gateway temporarily unreachable');
    }
  }
}

const defaultInstance = new CashfreeProvider();
defaultInstance.CashfreeProvider = CashfreeProvider;

module.exports = defaultInstance;
module.exports.CashfreeProvider = CashfreeProvider;
