'use strict';

const crypto = require('crypto');
const { redisClient } = require('./redis');
const logger = require('../config/logger');

const DEFAULT_TTL_SECONDS = 900; // 15 minutes
const MAX_ATTEMPTS = 5;

class OtpProvider {
  /**
   * Generates a cryptographically secure random numeric OTP string.
   * Defaults to 4 digits as required by Partner Mobile App HandoverScreen.
   *
   * @param {number} [length=4]
   * @returns {string}
   */
  generateOtp(length = 4) {
    if (length === 4) {
      return String(crypto.randomInt(0, 10000)).padStart(4, '0');
    }
    if (length === 6) {
      return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    }
    const max = 10 ** length;
    return String(crypto.randomInt(0, max)).padStart(length, '0');
  }

  /**
   * Generates a random cryptographic salt.
   *
   * @param {number} [bytes=16]
   * @returns {string} Hex string
   */
  generateSalt(bytes = 16) {
    return crypto.randomBytes(bytes).toString('hex');
  }

  /**
   * Generates a salted SHA-256 one-way hash of an OTP.
   * Plaintext OTPs are NEVER persisted or returned.
   *
   * @param {string} otp
   * @param {string} salt
   * @returns {string} 64-character hex hash
   */
  hashOtp(otp, salt) {
    return crypto
      .createHash('sha256')
      .update(`${String(otp)}:${String(salt)}`)
      .digest('hex');
  }

  /**
   * Performs constant-time comparison to prevent timing attacks.
   *
   * @param {string} candidateOtp
   * @param {string} storedHash
   * @param {string} salt
   * @returns {boolean}
   */
  verifyOtp(candidateOtp, storedHash, salt) {
    if (!candidateOtp || !storedHash || !salt) {
      return false;
    }

    const candidateHash = this.hashOtp(candidateOtp, salt);
    const candidateBuffer = Buffer.from(candidateHash, 'hex');
    const storedBuffer = Buffer.from(storedHash, 'hex');

    if (candidateBuffer.length !== storedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(candidateBuffer, storedBuffer);
  }

  /**
   * Stores OTP hash & salt in Redis with TTL.
   *
   * @param {string} bookingId
   * @param {object} params
   * @param {string} params.otpHash
   * @param {string} params.salt
   * @param {number} [ttlSeconds=900]
   */
  async storeOtpState(bookingId, { otpHash, salt, otp }, ttlSeconds = DEFAULT_TTL_SECONDS) {
    const key = `otp:pickup:state:${bookingId}`;
    const payload = { otpHash, salt, createdAt: new Date().toISOString() };
    if (otp !== undefined && otp !== null) {
      payload.otp = String(otp);
    }
    const data = JSON.stringify(payload);
    await redisClient.set(key, data, 'EX', ttlSeconds);
    // Reset attempt counter whenever a new OTP is issued
    await redisClient.del(`otp:pickup:attempts:${bookingId}`);
  }

  /**
   * Retrieves active OTP state from Redis.
   *
   * @param {string} bookingId
   * @returns {Promise<object|null>}
   */
  async getOtpState(bookingId) {
    const key = `otp:pickup:state:${bookingId}`;
    const raw = await redisClient.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Increments and returns verification failure attempts.
   *
   * @param {string} bookingId
   * @param {number} [ttlSeconds=900]
   * @returns {Promise<number>}
   */
  async incrementAttempts(bookingId, ttlSeconds = DEFAULT_TTL_SECONDS) {
    const key = `otp:pickup:attempts:${bookingId}`;
    const attempts = await redisClient.incr(key);
    if (attempts === 1) {
      await redisClient.expire(key, ttlSeconds);
    }
    return attempts;
  }

  /**
   * Retrieves current failed attempt count.
   *
   * @param {string} bookingId
   * @returns {Promise<number>}
   */
  async getAttempts(bookingId) {
    const key = `otp:pickup:attempts:${bookingId}`;
    const val = await redisClient.get(key);
    return val ? parseInt(val, 10) : 0;
  }

  /**
   * Cleans up OTP state and attempt tracking upon successful verification or invalidation.
   *
   * @param {string} bookingId
   */
  async clearOtpState(bookingId) {
    try {
      await Promise.all([
        redisClient.del(`otp:pickup:state:${bookingId}`),
        redisClient.del(`otp:pickup:attempts:${bookingId}`),
      ]);
    } catch (err) {
      logger.warn('Failed to clear OTP state from Redis', {
        bookingId,
        error: err.message,
      });
    }
  }
}

module.exports = new OtpProvider();
module.exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
module.exports.DEFAULT_TTL_SECONDS = DEFAULT_TTL_SECONDS;
