'use strict';

const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../config/logger');
const { ServiceUnavailableError, BadRequestError } = require('../errors');
const { PAYMENT_ERROR_CODES } = require('../constants/payment');

/**
 * CashfreeProvider — Production implementation of Cashfree Payment Gateway API (PG v2023-08-01).
 *
 * Reuses verified cryptographic signature verification, replay protection, and status retrieval
 * matching the Customer Backend architecture. Supports mockDelegate for deterministic tests.
 */
class CashfreeProvider {
  constructor(options = {}) {
    this.appId = options.appId || env.CASHFREE_APP_ID;
    this.secretKey = options.secretKey || env.CASHFREE_SECRET_KEY;
    this.envMode = (options.env || env.CASHFREE_ENV || 'SANDBOX').toUpperCase();
    this.apiVersion = options.apiVersion || env.CASHFREE_API_VERSION;

    this.baseUrl = this.envMode === 'PRODUCTION'
      ? 'https://api.cashfree.com/pg'
      : 'https://sandbox.cashfree.com/pg';

    this.mockDelegate = null;
  }

  /**
   * Sets mock delegate for testing.
   *
   * @param {object|null} delegate
   */
  setMockDelegate(delegate) {
    this.mockDelegate = delegate;
  }

  /**
   * Cashfree HTTP headers. Never logs secretKey.
   *
   * @private
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
   * Fetches order status from Cashfree Payment Gateway.
   *
   * @param {string} providerOrderId
   * @returns {Promise<{providerOrderId: string, orderStatus: string,
   *   orderAmount: number|null, orderCurrency: string}>}
   */
  async getOrderStatus(providerOrderId) {
    if (this.mockDelegate && typeof this.mockDelegate.getOrderStatus === 'function') {
      return this.mockDelegate.getOrderStatus(providerOrderId);
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

      return {
        providerOrderId: data.order_id || providerOrderId,
        orderStatus: data.order_status,
        orderAmount: data.order_amount ? Number(data.order_amount) : null,
        orderCurrency: data.order_currency || 'INR',
      };
    } catch (err) {
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
   * Cryptographically verifies Cashfree webhook signature using HMAC-SHA256.
   *
   * Algorithm per Cashfree PG documentation:
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

    if (!timestamp || !signature || !this.secretKey) {
      return false;
    }

    // Clock skew replay protection:
    // Max 10 minutes (600s) in past, max 5 minutes (300s) in future
    const nowSec = Math.floor(Date.now() / 1000);
    const tsNum = Number(timestamp);
    let tsSec;
    if (!Number.isNaN(tsNum)) {
      tsSec = tsNum > 1e11 ? Math.floor(tsNum / 1000) : tsNum;
    } else {
      tsSec = Math.floor(Date.parse(timestamp) / 1000);
    }

    if (Number.isNaN(tsSec) || (nowSec - tsSec) > 600 || (tsSec - nowSec) > 300) {
      logger.warn('Cashfree webhook timestamp outside acceptable clock skew window', {
        webhookTimestamp: timestamp,
        currentTime: nowSec,
      });
      return false;
    }

    const dataToSign = `${timestamp}${rawBody}`;
    const expectedSignature = crypto
      .createHmac('sha256', this.secretKey)
      .update(dataToSign)
      .digest('base64');

    const sigBuf = Buffer.from(String(signature), 'utf8');
    const expectedBuf = Buffer.from(expectedSignature, 'utf8');

    if (sigBuf.length !== expectedBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(sigBuf, expectedBuf);
  }
}

module.exports = new CashfreeProvider();
