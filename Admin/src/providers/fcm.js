'use strict';

const logger = require('../config/logger');

const INVALID_TOKEN_ERROR_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
  'messaging/invalid-argument',
]);

const DISALLOWED_PAYLOAD_KEYS = new Set([
  'password',
  'otp',
  'token',
  'secret',
  'credentials',
  'privatekey',
  'authorization',
]);

class FcmProvider {
  constructor() {
    this.mockDelegate = null;
  }

  /**
   * Sets mock delegate for isolated unit/integration testing without live FCM calls.
   *
   * @param {object|null} delegate
   */
  setMockDelegate(delegate) {
    this.mockDelegate = delegate;
  }

  /**
   * Resets the mock delegate.
   */
  resetMockDelegate() {
    this.mockDelegate = null;
  }

  /**
   * Normalizes data payload values strictly to strings for FCM specifications,
   * while redacting sensitive fields.
   *
   * @param {object} [data={}]
   * @returns {Record<string, string>}
   */
  static formatPayloadData(data = {}) {
    if (!data || typeof data !== 'object') {
      return {};
    }

    const sanitized = {};
    Object.entries(data).forEach(([key, value]) => {
      if (
        !DISALLOWED_PAYLOAD_KEYS.has(key.toLowerCase())
        && value !== undefined
        && value !== null
      ) {
        sanitized[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
      }
    });

    return sanitized;
  }

  /**
   * Sends multicast push notification using push messaging service.
   *
   * @param {object} params
   * @param {string[]} params.tokens Device tokens
   * @param {string} params.title Notification title
   * @param {string} params.body Notification message
   * @param {object} [params.data] Custom payload data
   * @param {string} [params.sound] Custom sound
   * @param {string} [params.channelId] Android notification channel
   * @returns {Promise<{
   *   successCount: number, failureCount: number, invalidTokens: string[], reason?: string
   * }>}
   */
  async sendMulticast({
    tokens,
    title,
    body,
    data = {},
    sound = 'default',
    channelId = 'gongo_notifications',
  }) {
    if (!Array.isArray(tokens) || tokens.length === 0) {
      return { successCount: 0, failureCount: 0, invalidTokens: [] };
    }

    if (this.mockDelegate && typeof this.mockDelegate.sendMulticast === 'function') {
      return this.mockDelegate.sendMulticast({ tokens, title, body, data, sound, channelId });
    }

    logger.info('Push messaging provider not configured for live dispatch; skipping live push');
    return {
      successCount: 0,
      failureCount: tokens.length,
      invalidTokens: [],
      reason: 'PUSH_NOT_CONFIGURED',
    };
  }
}

module.exports = new FcmProvider();
