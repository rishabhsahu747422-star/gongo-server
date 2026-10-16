'use strict';

const SmsProvider = require('./sms.provider');
const { env, logger } = require('../../config');
const { ServiceUnavailableError } = require('../../errors');

/**
 * MSG91 SMS Provider implementing OTP delivery via MSG91 v5 API.
 * Uses native fetch (Node.js >= 18).
 * Credentials and template IDs are read strictly from environment variables.
 */
class Msg91Provider extends SmsProvider {
  constructor() {
    super();
    this.authKey = env.MSG91_AUTH_KEY;
    this.templateId = env.MSG91_TEMPLATE_ID;
    this.senderId = env.MSG91_SENDER_ID;
    this.endpoint = 'https://control.msg91.com/api/v5/otp';
  }

  /**
   * Sends an OTP via MSG91 v5 API.
   *
   * @param {object} params
   * @param {string} params.mobile - Normalized phone number with country code (digits only)
   * @param {string} params.otp - 6-digit OTP
   * @returns {Promise<{ success: boolean, messageId?: string }>}
   */
  async sendOtp({ mobile, otp }) {
    // In test environment or dry-run mode when no auth key configured
    if (env.NODE_ENV === 'test' || !this.authKey) {
      logger.info('MSG91 sendOtp simulated (test or unconfigured credentials)', {
        mobileMasked: mobile.replace(/\d(?=\d{4})/g, '*'),
      });
      return { success: true, messageId: 'msg91-mock-id' };
    }

    const expiryMinutes = Math.max(1, Math.ceil(env.AUTH_OTP_EXPIRY_SECONDS / 60));

    try {
      const payload = {
        template_id: this.templateId,
        mobile,
        otp,
        otp_expiry: expiryMinutes,
      };

      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          authkey: this.authKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const responseData = await response.json().catch(() => ({}));

      if (!response.ok || responseData.type === 'error') {
        logger.error('MSG91 API error response', {
          statusCode: response.status,
          responseType: responseData.type,
          // Never log payload, authkey, or OTP
        });
        throw new ServiceUnavailableError('SMS service temporarily unavailable', 'SMS_DELIVERY_FAILED');
      }

      logger.info('MSG91 OTP dispatched successfully', {
        mobileMasked: mobile.replace(/\d(?=\d{4})/g, '*'),
      });

      return {
        success: true,
        messageId: responseData.message || 'dispatched',
      };
    } catch (err) {
      if (err instanceof ServiceUnavailableError) {
        throw err;
      }

      logger.error('MSG91 network dispatch error', {
        name: err.name,
        code: err.code || 'UNKNOWN',
      });
      throw new ServiceUnavailableError('Failed to dispatch verification SMS', 'SMS_DELIVERY_FAILED');
    }
  }
}

module.exports = Msg91Provider;
