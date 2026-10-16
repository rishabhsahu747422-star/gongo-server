'use strict';

const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../config/logger');
const { ServiceUnavailableError, BadRequestError } = require('../errors');

/**
 * CashfreeProvider — Production implementation of Cashfree Payment Gateway API (PG v2023-08-01).
 *
 * Provides administrative reconciliation, order lookup, and controlled refund execution.
 * Cryptographically verifies signatures and never exposes sensitive credentials in logs.
 * Supports mock delegates for deterministic test isolation.
 */
class CashfreeProvider {
  constructor(options = {}) {
    this.appId = options.appId || env.CASHFREE_APP_ID;
    this.secretKey = options.secretKey || env.CASHFREE_SECRET_KEY;
    this.envMode = options.env || env.CASHFREE_ENV;
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
   * Resets mock delegate.
   */
  resetMockDelegate() {
    this.mockDelegate = null;
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
   * Fetches order status from Cashfree PG.
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
        );
      }

      return {
        providerOrderId: data.order_id || providerOrderId,
        orderStatus: data.order_status,
        orderAmount: data.order_amount ? Number(data.order_amount) : null,
        orderCurrency: data.order_currency || 'INR',
        cfOrderId: data.cf_order_id ? String(data.cf_order_id) : null,
      };
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      logger.error('Cashfree connection error during getOrderStatus', {
        providerOrderId,
        error: err.message,
      });
      throw new ServiceUnavailableError('Payment gateway temporarily unreachable');
    }
  }

  /**
   * Initiates a refund for an order on Cashfree.
   *
   * @param {object} params
   * @param {string} params.orderId
   * @param {number} params.refundAmount
   * @param {string} params.refundId - Unique refund ID / reference
   * @param {string} [params.refundNote]
   * @returns {Promise<{providerRefundId: string, refundStatus: string, refundAmount: number}>}
   */
  async createRefund({ orderId, refundAmount, refundId, refundNote }) {
    if (this.mockDelegate && typeof this.mockDelegate.createRefund === 'function') {
      return this.mockDelegate.createRefund({ orderId, refundAmount, refundId, refundNote });
    }

    const payload = {
      refund_amount: Number(refundAmount),
      refund_id: refundId,
      refund_note: refundNote || 'Admin initiated refund',
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
   * Cryptographically verifies Cashfree webhook signature using HMAC-SHA256.
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

  /**
   * Initiates a payout transfer to a bank account via Cashfree Payouts.
   *
   * @param {object} params
   * @param {string} params.transferId
   * @param {number} params.amount
   * @param {object} params.beneficiaryDetails
   * @param {string} [params.transferMode] - 'banktransfer', 'imps', 'neft'
   * @param {string} [params.remarks]
   * @returns {Promise<{providerTransferId: string, transferStatus: string, utr: string|null}>}
   */
  async initiatePayoutTransfer({
    transferId,
    amount,
    beneficiaryDetails,
    transferMode = 'banktransfer',
    remarks = 'Admin approved partner payout',
  }) {
    if (this.mockDelegate && typeof this.mockDelegate.initiatePayoutTransfer === 'function') {
      return this.mockDelegate.initiatePayoutTransfer({
        transferId,
        amount,
        beneficiaryDetails,
        transferMode,
        remarks,
      });
    }

    const payoutUrl = this.envMode === 'PRODUCTION'
      ? 'https://payout-api.cashfree.com/payout/v1/requestTransfer'
      : 'https://payout-gamma.cashfree.com/payout/v1/requestTransfer';

    const payload = {
      transferId,
      amount: String(amount),
      transferMode,
      remarks,
      beneDetails: {
        bankAccount: beneficiaryDetails.accountNumber,
        ifsc: beneficiaryDetails.ifscCode,
        name: beneficiaryDetails.accountHolderName,
      },
    };

    try {
      const response = await fetch(payoutUrl, {
        method: 'POST',
        headers: this._getHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || data.status === 'ERROR') {
        logger.error('Cashfree payout transfer initiation failed', {
          status: response.status,
          transferId,
          message: data.message || data.subCode,
        });
        throw new BadRequestError(
          data.message || 'Payment provider rejected payout transfer request',
        );
      }

      const resData = data.data || {};
      return {
        providerTransferId: resData.referenceId || data.referenceId || transferId,
        transferStatus: resData.status || 'PENDING',
        utr: resData.utr || null,
      };
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      logger.error('Cashfree connection error during initiatePayoutTransfer', {
        transferId,
        error: err.message,
      });
      throw new ServiceUnavailableError('Payout gateway temporarily unreachable');
    }
  }

  /**
   * Retrieves payout transfer status from Cashfree Payouts.
   *
   * @param {string} transferId
   * @returns {Promise<{transferId: string, status: string, utr: string|null}>}
   */
  async getPayoutTransferStatus(transferId) {
    if (this.mockDelegate && typeof this.mockDelegate.getPayoutTransferStatus === 'function') {
      return this.mockDelegate.getPayoutTransferStatus(transferId);
    }

    const basePayout = this.envMode === 'PRODUCTION'
      ? 'https://payout-api.cashfree.com/payout/v1'
      : 'https://payout-gamma.cashfree.com/payout/v1';
    const payoutUrl = `${basePayout}/getTransferStatus?transferId=${encodeURIComponent(transferId)}`;

    try {
      const response = await fetch(payoutUrl, {
        method: 'GET',
        headers: this._getHeaders(),
        signal: AbortSignal.timeout(10000),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || data.status === 'ERROR') {
        logger.error('Cashfree get payout status failed', {
          status: response.status,
          transferId,
          message: data.message,
        });
        throw new BadRequestError(
          data.message || 'Failed to retrieve payout status from payment provider',
        );
      }

      const resData = data.data || {};
      return {
        transferId,
        status: resData.status || 'PENDING',
        utr: resData.utr || null,
      };
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      logger.error('Cashfree connection error during getPayoutTransferStatus', {
        transferId,
        error: err.message,
      });
      throw new ServiceUnavailableError('Payout gateway temporarily unreachable');
    }
  }
}

module.exports = new CashfreeProvider();
