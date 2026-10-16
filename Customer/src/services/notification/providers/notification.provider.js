'use strict';

/**
 * Base abstract NotificationProvider interface.
 * Any push notification gateway (Firebase Cloud Messaging, APNs, etc.)
 * must inherit from this class and implement the contract.
 */
class NotificationProvider {
  /**
   * Sends multicast push notification to multiple device tokens.
   *
   * @param {object} params
   * @param {string[]} params.tokens
   * @param {string} params.title
   * @param {string} params.body
   * @param {object} [params.data]
   * @returns {Promise<{successCount: number, failureCount: number, invalidTokens: string[]}>}
   */
  async sendMulticast() {
    throw new Error('NotificationProvider.sendMulticast must be implemented by subclass');
  }
}

module.exports = NotificationProvider;
