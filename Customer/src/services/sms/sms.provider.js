'use strict';

/**
 * Abstract SMS Provider interface.
 * Any SMS provider (MSG91, Twilio, AWS SNS, etc.) must implement this contract.
 * Business logic depends strictly on this interface, allowing painless provider swapping.
 */
class SmsProvider {
  /**
   * Sends an OTP to the designated recipient.
   *
   * @param {object} params
   * @param {string} params.mobile - Normalized phone number with country code (e.g. "919876543210")
   * @param {string} params.otp - 6-digit OTP string
   * @param {string} params.countryCode - Country code (e.g. "+91")
   * @returns {Promise<{ success: boolean, messageId?: string }>}
   */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async sendOtp(params) {
    throw new Error('sendOtp must be implemented by concrete SmsProvider');
  }
}

module.exports = SmsProvider;
