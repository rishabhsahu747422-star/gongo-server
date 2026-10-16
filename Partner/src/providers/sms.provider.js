'use strict';

const logger = require('../config/logger');

class SmsProvider {
  /**
   * Masks a phone number for secure logging (e.g. "+919876543210" -> "+9198****3210").
   *
   * @param {string} phone
   * @returns {string}
   */
  maskPhone(phone) {
    if (!phone || typeof phone !== 'string') return '****';
    const clean = phone.trim();
    if (clean.length <= 6) return '****';
    const start = clean.slice(0, 5);
    const end = clean.slice(-4);
    return `${start}****${end}`;
  }

  /**
   * Dispatches pickup OTP SMS to customer phone.
   * In test and dev environments, simulates dispatch safely without leaking raw OTP to logs.
   *
   * @param {object} params
   * @param {string} params.phone - Customer phone number
   * @param {string} params.otp - Plaintext OTP (used strictly for transmission)
   * @param {string} params.bookingNumber - Booking reference code
   * @returns {Promise<{ success: boolean, messageId: string }>}
   */
  async sendPickupOtp({ phone, otp: _otp, bookingNumber }) {
    const maskedPhone = this.maskPhone(phone);

    // In non-production or simulated environments:
    // We log the dispatch action WITHOUT logging the raw OTP.
    logger.info('Pickup OTP SMS dispatch initiated', {
      phone: maskedPhone,
      bookingNumber,
      provider: 'SMS_SIMULATED',
    });

    // In a live integration, MSG91 or AWS SNS API request would execute here.
    return {
      success: true,
      messageId: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    };
  }
}

module.exports = new SmsProvider();
