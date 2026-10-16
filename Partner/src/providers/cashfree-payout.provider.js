'use strict';

const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../config/logger');
const { ServiceUnavailableError, BadRequestError } = require('../errors');

/**
 * CashfreePayoutProvider — Implementation of Cashfree Payouts API v2.
 *
 * Dedicated to Partner Wallet withdrawals. Encapsulates beneficiary synchronization,
 * transfer initiation, status verification, and cryptographic webhook validation.
 * Supports mockDelegate for deterministic test isolation.
 */
class CashfreePayoutProvider {
  constructor(options = {}) {
    this.appId = options.appId || env.CASHFREE_APP_ID;
    this.secretKey = options.secretKey || env.CASHFREE_SECRET_KEY;
    this.envMode = (options.env || env.CASHFREE_ENV || 'SANDBOX').toUpperCase();
    this.apiVersion = options.apiVersion || env.CASHFREE_PAYOUT_API_VERSION || '2024-01-01';

    if (options.baseUrl) {
      this.baseUrl = options.baseUrl;
    } else if (env.CASHFREE_PAYOUT_BASE_URL) {
      this.baseUrl = env.CASHFREE_PAYOUT_BASE_URL;
    } else {
      this.baseUrl = this.envMode === 'PRODUCTION'
        ? 'https://api.cashfree.com/payout'
        : 'https://sandbox.cashfree.com/payout';
    }

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
   * Returns true if provider is configured with live/sandbox credentials or a mock delegate.
   *
   * @returns {boolean}
   */
  isConfigured() {
    return this._hasConfiguredCredentials() || Boolean(this.mockDelegate);
  }

  /**
   * Checks whether valid live/sandbox API credentials are configured.
   * Protects test runners from hanging on remote fetch with dummy test keys.
   *
   * @private
   * @returns {boolean}
   */
  _hasConfiguredCredentials() {
    if (!this.appId || !this.secretKey) return false;
    if (this.appId === 'TEST_CASHFREE_APP_ID' || this.secretKey === 'TEST_CASHFREE_SECRET_KEY') return false;
    if (this.appId.startsWith('TEST_') && this.secretKey.startsWith('TEST_')) return false;
    return true;
  }

  /**
   * Generates standard Cashfree Payouts HTTP headers.
   * Never exposes or logs secretKey.
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
   * Creates or registers a beneficiary in Cashfree Payouts v2.
   *
   * @param {object} params
   * @param {string} params.beneficiaryId
   * @param {string} params.beneficiaryName
   * @param {string} params.accountNumber
   * @param {string} params.ifscCode
   * @param {string} [params.email]
   * @param {string} [params.phone]
   * @returns {Promise<object>}
   */
  async createBeneficiary({
    beneficiaryId,
    beneficiaryName,
    accountNumber,
    ifscCode,
    email = 'partner@gongo.in',
    phone = '9999999999',
  }) {
    if (this.mockDelegate && typeof this.mockDelegate.createBeneficiary === 'function') {
      return this.mockDelegate.createBeneficiary({
        beneficiaryId,
        beneficiaryName,
        accountNumber,
        ifscCode,
        email,
        phone,
      });
    }

    if (!this._hasConfiguredCredentials()) {
      throw new ServiceUnavailableError('Cashfree credentials not configured in environment');
    }

    const payload = {
      beneficiary_id: beneficiaryId,
      beneficiary_name: beneficiaryName,
      beneficiary_instrument_details: {
        bank_account_number: accountNumber,
        bank_ifsc: ifscCode,
      },
      beneficiary_contact_details: {
        beneficiary_email: email,
        beneficiary_phone: phone,
      },
    };

    try {
      const response = await fetch(`${this.baseUrl}/beneficiary`, {
        method: 'POST',
        headers: this._getHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });

      const data = await response.json().catch(() => ({}));

      // Cashfree returns 409 or subcode if beneficiary already exists (idempotent handling)
      if (response.status === 409 || data.sub_code === 'BENEFICIARY_ALREADY_EXISTS'
        || (data.message && data.message.toLowerCase().includes('already exists'))) {
        logger.info('Cashfree beneficiary already exists (idempotent)', { beneficiaryId });
        return { beneficiaryId, status: 'EXISTS', data };
      }

      if (!response.ok) {
        logger.error('Cashfree beneficiary creation failed', {
          status: response.status,
          beneficiaryId,
          message: data.message || data.sub_code,
        });
        throw new BadRequestError(
          data.message || 'Payment provider rejected beneficiary creation',
        );
      }

      return {
        beneficiaryId: data.beneficiary_id || beneficiaryId,
        status: data.status || 'CREATED',
        data,
      };
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      logger.error('Cashfree connection error during createBeneficiary', {
        beneficiaryId,
        error: err.message,
      });
      throw new ServiceUnavailableError('Payout gateway temporarily unreachable');
    }
  }

  /**
   * Retrieves beneficiary details by ID.
   *
   * @param {string} beneficiaryId
   * @returns {Promise<object|null>}
   */
  async getBeneficiary(beneficiaryId) {
    if (this.mockDelegate && typeof this.mockDelegate.getBeneficiary === 'function') {
      return this.mockDelegate.getBeneficiary(beneficiaryId);
    }

    if (!this._hasConfiguredCredentials()) {
      throw new ServiceUnavailableError('Cashfree credentials not configured in environment');
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/beneficiary?beneficiary_id=${encodeURIComponent(beneficiaryId)}`,
        {
          method: 'GET',
          headers: this._getHeaders(),
          signal: AbortSignal.timeout(10000),
        },
      );

      const data = await response.json().catch(() => ({}));

      if (response.status === 404 || data.sub_code === 'BENEFICIARY_DOES_NOT_EXIST') {
        return null;
      }

      if (!response.ok) {
        logger.error('Cashfree get beneficiary failed', {
          status: response.status,
          beneficiaryId,
          message: data.message,
        });
        throw new BadRequestError(
          data.message || 'Failed to retrieve beneficiary from payment provider',
        );
      }

      return data;
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      logger.error('Cashfree connection error during getBeneficiary', {
        beneficiaryId,
        error: err.message,
      });
      throw new ServiceUnavailableError('Payout gateway temporarily unreachable');
    }
  }

  /**
   * Ensures that a beneficiary is registered in Cashfree before transfer initiation.
   *
   * @param {object} params
   * @returns {Promise<object>}
   */
  async ensureBeneficiary(params) {
    if (this.mockDelegate && typeof this.mockDelegate.ensureBeneficiary === 'function') {
      return this.mockDelegate.ensureBeneficiary(params);
    }
    return this.createBeneficiary(params);
  }

  /**
   * Initiates a fund transfer to a beneficiary via Cashfree Payouts v2.
   *
   * @param {object} params
   * @param {string} params.transferId - GONGO unique payout transfer identifier
   * @param {number} params.amount - Transfer amount in INR
   * @param {string} [params.currency='INR']
   * @param {string} params.beneficiaryId - Beneficiary ID in Cashfree
   * @param {string} [params.transferMode='banktransfer']
   * @param {string} [params.remarks='Partner wallet payout']
   * @returns {Promise<{transferId: string, cfTransferId: string|null, status: string, statusDescription: string|null}>}
   */
  async initiateTransfer({
    transferId,
    amount,
    currency = 'INR',
    beneficiaryId,
    transferMode = 'banktransfer',
    remarks = 'Partner wallet payout',
  }) {
    if (this.mockDelegate && typeof this.mockDelegate.initiateTransfer === 'function') {
      return this.mockDelegate.initiateTransfer({
        transferId,
        amount,
        currency,
        beneficiaryId,
        transferMode,
        remarks,
      });
    }

    if (!this._hasConfiguredCredentials()) {
      throw new ServiceUnavailableError('Cashfree credentials not configured in environment');
    }

    const payload = {
      transfer_id: transferId,
      transfer_amount: Number(Number(amount).toFixed(2)),
      transfer_currency: currency,
      transfer_mode: transferMode,
      beneficiary_details: {
        beneficiary_id: beneficiaryId,
      },
      transfer_remarks: remarks,
    };

    try {
      const response = await fetch(`${this.baseUrl}/transfers`, {
        method: 'POST',
        headers: this._getHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        logger.error('Cashfree transfer initiation failed', {
          status: response.status,
          transferId,
          message: data.message || data.sub_code,
        });
        throw new BadRequestError(
          data.message || 'Payment provider rejected payout transfer request',
        );
      }

      return {
        transferId: data.transfer_id || transferId,
        cfTransferId: data.cf_transfer_id ? String(data.cf_transfer_id) : null,
        status: data.status || 'RECEIVED',
        statusDescription: data.status_description || null,
      };
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      logger.error('Cashfree connection error during initiateTransfer', {
        transferId,
        error: err.message,
      });
      throw new ServiceUnavailableError('Payout gateway temporarily unreachable');
    }
  }

  /**
   * Retrieves status of a transfer from Cashfree Payouts v2.
   *
   * @param {string} transferId
   * @returns {Promise<{transferId: string, cfTransferId: string|null, status: string, statusDescription: string|null, utr: string|null}>}
   */
  async getTransferStatus(transferId) {
    if (this.mockDelegate && typeof this.mockDelegate.getTransferStatus === 'function') {
      return this.mockDelegate.getTransferStatus(transferId);
    }

    if (!this._hasConfiguredCredentials()) {
      throw new ServiceUnavailableError('Cashfree credentials not configured in environment');
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/transfers/${encodeURIComponent(transferId)}`,
        {
          method: 'GET',
          headers: this._getHeaders(),
          signal: AbortSignal.timeout(10000),
        },
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        logger.error('Cashfree get transfer status failed', {
          status: response.status,
          transferId,
          message: data.message,
        });
        throw new BadRequestError(
          data.message || 'Failed to retrieve transfer status from payment provider',
        );
      }

      return {
        transferId: data.transfer_id || transferId,
        cfTransferId: data.cf_transfer_id ? String(data.cf_transfer_id) : null,
        status: (data.status || '').toUpperCase(),
        statusDescription: data.status_description || null,
        utr: data.utr || null,
      };
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      logger.error('Cashfree connection error during getTransferStatus', {
        transferId,
        error: err.message,
      });
      throw new ServiceUnavailableError('Payout gateway temporarily unreachable');
    }
  }

  /**
   * Cryptographically verifies Cashfree webhook signature using HMAC-SHA256.
   *
   * Algorithm per Cashfree documentation:
   *   dataToSign = timestamp + rawBody
   *   expectedSignature = Base64(HMAC_SHA256(dataToSign, secretKey))
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

    // Clock skew replay protection: max 10m (600s) past, max 5m (300s) future
    const nowSec = Math.floor(Date.now() / 1000);
    const tsNum = Number(timestamp);
    let tsSec;
    if (!Number.isNaN(tsNum)) {
      tsSec = tsNum > 1e11 ? Math.floor(tsNum / 1000) : tsNum;
    } else {
      tsSec = Math.floor(Date.parse(timestamp) / 1000);
    }

    if (Number.isNaN(tsSec) || (nowSec - tsSec) > 600 || (tsSec - nowSec) > 300) {
      logger.warn('Cashfree payout webhook timestamp outside clock skew window', {
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

module.exports = new CashfreePayoutProvider();
