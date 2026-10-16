'use strict';

const NotificationProvider = require('./notification.provider');
const { getFirebaseMessaging } = require('../../../config/firebase');
const logger = require('../../../config/logger');

const {
  NOTIFICATION_SOUNDS,
  NOTIFICATION_CHANNELS,
} = require('../../../constants/notification');

const INVALID_TOKEN_ERROR_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
  'messaging/invalid-argument',
]);

/**
 * Firebase Notification Provider (FCM) implementing push delivery.
 */
class FirebaseNotificationProvider extends NotificationProvider {
  constructor() {
    super();
    this.mockDelegate = null;
  }

  /**
   * Allows injecting a mock delegate in tests without live Google network calls.
   *
   * @param {object|null} delegate
   */
  setMockDelegate(delegate) {
    this.mockDelegate = delegate;
  }

  /**
   * Normalizes data payload values strictly to strings for FCM compatibility.
   *
   * @param {object} [data={}]
   * @returns {Record<string, string>}
   */
  static formatPayloadData(data = {}) {
    if (!data || typeof data !== 'object') {
      return {};
    }

    const sanitized = {};
    const disallowedKeys = new Set(['password', 'otp', 'token', 'secret', 'credentials']);

    Object.entries(data).forEach(([key, value]) => {
      if (!disallowedKeys.has(key.toLowerCase()) && value !== undefined && value !== null) {
        sanitized[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
      }
    });

    return sanitized;
  }

  /**
   * Sends multicast push notification using Firebase Cloud Messaging.
   *
   * @param {object} params
   * @param {string[]} params.tokens
   * @param {string} params.title
   * @param {string} params.body
   * @param {object} [params.data]
   * @param {string} [params.sound]
   * @param {string} [params.channelId]
   * @returns {Promise<{successCount: number, failureCount: number, invalidTokens: string[]}>}
   */
  async sendMulticast({
    tokens,
    title,
    body,
    data = {},
    sound = NOTIFICATION_SOUNDS.DEFAULT,
    channelId = NOTIFICATION_CHANNELS.DEFAULT,
  }) {
    if (!Array.isArray(tokens) || tokens.length === 0) {
      return { successCount: 0, failureCount: 0, invalidTokens: [] };
    }

    if (this.mockDelegate && typeof this.mockDelegate.sendMulticast === 'function') {
      return this.mockDelegate.sendMulticast({ tokens, title, body, data, sound, channelId });
    }

    const messaging = getFirebaseMessaging();
    if (!messaging) {
      logger.warn('FCM messaging client not initialized; skipping push notification dispatch');
      return {
        successCount: 0,
        failureCount: tokens.length,
        invalidTokens: [],
        reason: 'FCM_NOT_INITIALIZED',
      };
    }

    const formattedData = FirebaseNotificationProvider.formatPayloadData(data);

    const message = {
      tokens,
      notification: {
        title,
        body,
      },
      data: formattedData,
    };

    if (sound && sound !== 'none') {
      message.android = {
        notification: {
          channelId: channelId || NOTIFICATION_CHANNELS.DEFAULT,
          sound,
        },
      };
      message.apns = {
        payload: {
          aps: {
            sound: sound.endsWith('.wav') ? sound : `${sound}.wav`,
          },
        },
      };
    }

    try {
      const response = await messaging.sendEachForMulticast(message);

      const invalidTokens = [];

      if (Array.isArray(response.responses)) {
        response.responses.forEach((res, idx) => {
          if (!res.success && res.error) {
            const errCode = res.error.code || '';
            if (INVALID_TOKEN_ERROR_CODES.has(errCode) || errCode.includes('registration-token')) {
              invalidTokens.push(tokens[idx]);
            }
          }
        });
      }

      logger.info('FCM multicast delivery result', {
        successCount: response.successCount,
        failureCount: response.failureCount,
        invalidCount: invalidTokens.length,
      });

      return {
        successCount: response.successCount,
        failureCount: response.failureCount,
        invalidTokens,
      };
    } catch (err) {
      logger.error('FCM sendEachForMulticast failed with error', {
        error: err.message,
        code: err.code || 'FCM_SEND_ERROR',
      });

      return {
        successCount: 0,
        failureCount: tokens.length,
        invalidTokens: [],
        reason: err.message,
      };
    }
  }
}

module.exports = new FirebaseNotificationProvider();
