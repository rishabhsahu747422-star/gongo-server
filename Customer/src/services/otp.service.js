'use strict';

const crypto = require('crypto');
const { env } = require('../config');
const { BadRequestError } = require('../errors');

/**
 * Service managing cryptographically secure OTP generation,
 * HMAC hashing, timing-safe verification, and phone number normalization.
 */
class OtpService {
  constructor() {
    // Secret salt used for HMAC hashing of temporary OTPs
    this.hashSecret = env.SUPABASE_SERVICE_ROLE_KEY || env.FIREBASE_PRIVATE_KEY || 'gongo-otp-hmac-salt';
  }

  /**
   * Generates a cryptographically secure 6-digit random OTP string.
   *
   * @returns {string} 6-digit OTP (e.g. "482910")
   */
  generateOtp() {
    // Generates integer in range [100000, 999999] inclusive
    const code = crypto.randomInt(100000, 1000000);
    return String(code);
  }

  /**
   * Generates a unique UUID v4 verification ID.
   *
   * @returns {string}
   */
  generateVerificationId() {
    return crypto.randomUUID();
  }

  /**
   * Hashes an OTP using HMAC-SHA256.
   * Plaintext OTPs are NEVER stored in Redis or database.
   *
   * @param {string} otp - 6-digit OTP
   * @returns {string} Hex-encoded HMAC hash
   */
  hashOtp(otp) {
    return crypto
      .createHmac('sha256', this.hashSecret)
      .update(String(otp))
      .digest('hex');
  }

  /**
   * Performs constant-time comparison between a candidate OTP and stored hash.
   * Prevents timing attacks.
   *
   * @param {string} candidateOtp - Plaintext OTP supplied by client
   * @param {string} storedHash - Stored HMAC hash from Redis
   * @returns {boolean} True if matching
   */
  verifyOtpHash(candidateOtp, storedHash) {
    if (!candidateOtp || !storedHash) return false;

    const candidateHash = this.hashOtp(candidateOtp);
    const candidateBuffer = Buffer.from(candidateHash, 'hex');
    const storedBuffer = Buffer.from(storedHash, 'hex');

    if (candidateBuffer.length !== storedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(candidateBuffer, storedBuffer);
  }

  /**
   * Normalizes and validates phone numbers.
   * Currently enforces standard Indian mobile number format:
   * - 10 digits
   * - Valid telecom prefixes (starts with 6, 7, 8, or 9)
   *
   * @param {string} countryCode - e.g. "+91" or "91"
   * @param {string} phone - e.g. "9876543210"
   * @returns {{ countryCode: string, phone: string, fullNumber: string }}
   */
  normalizePhone(countryCode = '+91', phone = '') {
    const rawCountryCode = String(countryCode || '+91').trim();
    const rawPhone = String(phone || '').trim();

    // Standardize countryCode with leading +
    const cleanCountryCode = rawCountryCode.startsWith('+')
      ? rawCountryCode
      : `+${rawCountryCode}`;

    // Strip all non-digit characters from phone
    const cleanPhone = rawPhone.replace(/\D/g, '');

    if (cleanCountryCode === '+91') {
      // Validate 10-digit Indian mobile
      if (!/^[6-9]\d{9}$/.test(cleanPhone)) {
        throw new BadRequestError(
          'Please enter a valid 10-digit Indian mobile number',
          'INVALID_PHONE_FORMAT',
        );
      }
    } else if (cleanPhone.length < 7 || cleanPhone.length > 15) {
      throw new BadRequestError('Invalid phone number format', 'INVALID_PHONE_FORMAT');
    }

    // Normalized identifier for SMS gateways (e.g. "919876543210")
    const dialCode = cleanCountryCode.replace(/\D/g, '');
    const fullNumber = `${dialCode}${cleanPhone}`;

    return {
      countryCode: cleanCountryCode,
      phone: cleanPhone,
      fullNumber,
    };
  }
}

module.exports = new OtpService();
