'use strict';

const env = require('../config/env');
const logger = require('../config/logger');
const {
  AppError,
  BadRequestError,
  ServiceUnavailableError,
} = require('../errors');

class RenflairProvider {
  /**
   * Masks a phone number for secure logging (e.g. "9876543210" -> "98****3210").
   *
   * @param {string} phone
   * @returns {string}
   */
  maskPhone(phone) {
    if (!phone || typeof phone !== 'string') return '****';
    const clean = phone.trim();
    if (clean.length <= 6) return '****';
    const start = clean.slice(0, 2);
    const end = clean.slice(-4);
    return `${start}****${end}`;
  }

  /**
   * Sanitizes a provider message, stripping phone numbers, API keys, and OTP codes.
   *
   * @param {string} msg
   * @param {string} [cleanPhone]
   * @returns {string}
   */
  sanitizeMessage(msg, cleanPhone) {
    if (!msg || typeof msg !== 'string') return 'SMS delivery failed';
    let safe = msg;
    if (cleanPhone) {
      safe = safe.split(cleanPhone).join(this.maskPhone(cleanPhone));
    }
    safe = safe.replace(/API=[^&\s]+/gi, 'API=[REDACTED]');
    safe = safe.replace(/OTP=[^&\s]+/gi, 'OTP=[REDACTED]');
    return safe;
  }

  /**
   * Dispatches 6-digit OTP SMS via Renflair SMS Gateway API.
   * Validates Renflair's actual HTTP response before reporting delivery success.
   *
   * Renflair API:
   * https://sms.renflair.in/V1.php?API={API}&PHONE={PHONE}&OTP={OTP}
   *
   * @param {object} params
   * @param {string} params.phone - 10-digit mobile number
   * @param {string} params.otp - 6-digit numeric OTP code
   * @returns {Promise<{ success: boolean, simulated: boolean, transactionId?: string }>}
   */
  async sendOtp({ phone, otp }) {
    const cleanPhone = String(phone || '').replace(/[^0-9]/g, '').slice(-10);
    if (!cleanPhone || cleanPhone.length !== 10) {
      throw new BadRequestError('Invalid phone number: 10-digit number required for SMS delivery', 'INVALID_PHONE');
    }

    const cleanOtp = String(otp || '').trim();
    if (!/^\d{6}$/.test(cleanOtp)) {
      throw new BadRequestError('Invalid OTP: exactly 6 digits required', 'INVALID_OTP_FORMAT');
    }

    const maskedPhone = this.maskPhone(cleanPhone);
    const apiKey = (process.env.RENFLAIR_API_KEY || env.RENFLAIR_API_KEY || '').trim();
    const baseUrl = process.env.RENFLAIR_BASE_URL || env.RENFLAIR_BASE_URL || 'https://sms.renflair.in/V1.php';
    const isProduction = process.env.NODE_ENV === 'production' || env.isProduction;

    // When Renflair credentials are not configured in test environment
    if (!apiKey) {
      if (!isProduction && (process.env.NODE_ENV === 'test' || env.NODE_ENV === 'test')) {
        logger.warn('Renflair SMS API key not configured; using simulated SMS delivery in test', {
          phone: maskedPhone,
        });
        return {
          success: true,
          simulated: true,
          transactionId: `sim_${Date.now()}`,
          message: 'Simulated SMS dispatch: Renflair credentials not configured in test environment',
        };
      }

      logger.error('Renflair SMS API key missing in environment');
      throw new ServiceUnavailableError('SMS service is temporarily unavailable. Missing provider credentials.', 'SMS_GATEWAY_CONFIG_ERROR');
    }

    // Call Renflair SMS Gateway
    const url = `${baseUrl}?API=${encodeURIComponent(apiKey)}&PHONE=${encodeURIComponent(cleanPhone)}&OTP=${encodeURIComponent(cleanOtp)}`;

    try {
      logger.info('Dispatching customer OTP via Renflair SMS Gateway', {
        phone: maskedPhone,
        provider: 'RENFLAIR',
      });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json, text/plain, */*',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const rawText = await response.text();
      let parsed = null;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        // Renflair may return plain text
      }

      logger.info('Renflair gateway response received', {
        phone: maskedPhone,
        httpStatus: response.status,
        response: this.sanitizeMessage(rawText.length > 200 ? rawText.slice(0, 200) : rawText, cleanPhone),
      });

      if (!response.ok) {
        logger.error('Renflair HTTP error response', {
          status: response.status,
          phone: maskedPhone,
        });
        throw new ServiceUnavailableError(`Renflair SMS delivery failed with HTTP status ${response.status}`, 'SMS_GATEWAY_ERROR');
      }

      // Validate Renflair business response
      const statusUpper = String(parsed?.status || '').toUpperCase();
      const rawUpper = String(rawText || '').toUpperCase();

      const isExplicitFailure =
        statusUpper === 'FAILED' ||
        statusUpper === 'ERROR' ||
        rawUpper.includes('INCORRECT API KEY') ||
        rawUpper.includes('NO API KEY FOUND') ||
        rawUpper.includes('INSUFFICIENT') ||
        rawUpper.includes('FAILED');

      const isSuccess =
        !isExplicitFailure &&
        (statusUpper === 'SUCCESS' ||
          statusUpper === 'SENT' ||
          parsed?.success === true ||
          parsed?.code === 200 ||
          (typeof rawText === 'string' &&
            (rawUpper.includes('SMS SENT') || rawUpper.includes('MESSAGE SENT'))));

      if (!isSuccess) {
        const rawMsg = parsed?.message || rawText || 'SMS delivery failed';
        const sanitizedMsg = this.sanitizeMessage(String(rawMsg), cleanPhone);

        logger.error('Renflair rejected OTP SMS delivery', {
          phone: maskedPhone,
          error: sanitizedMsg,
        });

        if (rawUpper.includes('INCORRECT API KEY') || rawUpper.includes('NO API KEY FOUND') || rawUpper.includes('INVALID API KEY')) {
          throw new ServiceUnavailableError('SMS gateway authentication failed. Please check provider credentials in server/.env.', 'SMS_AUTH_FAILED');
        }
        if (rawUpper.includes('INSUFFICIENT') || rawUpper.includes('CREDIT') || rawUpper.includes('BALANCE')) {
          throw new ServiceUnavailableError('SMS delivery failed: Insufficient SMS credits in Renflair account.', 'SMS_INSUFFICIENT_CREDITS');
        }
        if (rawUpper.includes('NO PHONE') || rawUpper.includes('INVALID PHONE')) {
          throw new BadRequestError('SMS delivery failed: Invalid recipient phone number.', 'INVALID_PHONE');
        }

        throw new ServiceUnavailableError(`SMS delivery failed from provider: ${sanitizedMsg}`, 'SMS_DELIVERY_FAILED');
      }

      logger.info('OTP SMS successfully dispatched by Renflair', {
        phone: maskedPhone,
        transactionId: parsed?.transaction_id || parsed?.msgId || null,
      });

      return {
        success: true,
        simulated: false,
        transactionId: parsed?.transaction_id || parsed?.msgId || `ren_${Date.now()}`,
      };
    } catch (err) {
      if (err instanceof AppError) {
        throw err;
      }

      if (err.name === 'AbortError') {
        logger.error('Renflair request timed out', { phone: maskedPhone });
        throw new ServiceUnavailableError('SMS gateway request timed out. Please try again.', 'SMS_GATEWAY_TIMEOUT');
      }

      logger.error('Failed to send OTP via Renflair', {
        phone: maskedPhone,
        error: err.message,
      });
      throw new ServiceUnavailableError(`SMS gateway connection error: ${err.message}`, 'SMS_GATEWAY_ERROR');
    }
  }
}

module.exports = new RenflairProvider();
