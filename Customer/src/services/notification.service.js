'use strict';

const DeviceTokenRepository = require('../repositories/device-token.repository');
const NotificationRepository = require('../repositories/notification.repository');
const firebaseNotificationProvider = require('./notification/providers/firebase.provider');
const {
  NOTIFICATION_STATUS,
  NOTIFICATION_ERROR_CODES,
} = require('../constants/notification');
const { NotFoundError } = require('../errors');
const logger = require('../config/logger');

/**
 * NotificationService — business orchestration for customer push notifications and history.
 */
class NotificationService {
  constructor(
    deviceTokenRepo = new DeviceTokenRepository(),
    notificationRepo = new NotificationRepository(),
    provider = firebaseNotificationProvider,
  ) {
    this.deviceTokenRepository = deviceTokenRepo;
    this.notificationRepository = notificationRepo;
    this.provider = provider;
  }

  // ── Device Token Management ───────────────────────────────────────────────

  /**
   * Registers or updates a device token for an authenticated customer.
   *
   * @param {string} customerId
   * @param {object} params
   * @param {string} params.deviceToken
   * @param {string} params.platform
   * @param {string} [params.appVersion]
   * @param {string} [params.deviceId]
   * @returns {Promise<object>}
   */
  async registerDevice(customerId, { deviceToken, platform, appVersion, deviceId }) {
    const device = await this.deviceTokenRepository.upsertToken({
      customerId,
      deviceToken,
      platform,
      appVersion,
      deviceId,
    });

    logger.info('Customer device registered successfully', {
      customerId,
      deviceId: device.id,
      platform: device.platform,
    });

    return device;
  }

  /**
   * Lists all devices associated with the customer.
   *
   * @param {string} customerId
   * @returns {Promise<object[]>}
   */
  async listDevices(customerId) {
    return this.deviceTokenRepository.findAllByCustomerId(customerId);
  }

  /**
   * Deactivates a device belonging to the customer.
   *
   * @param {string} customerId
   * @param {string} deviceId
   * @returns {Promise<{success: boolean}>}
   */
  async removeDevice(customerId, deviceId) {
    const existing = await this.deviceTokenRepository.findByIdAndCustomerId(customerId, deviceId);
    if (!existing) {
      throw new NotFoundError('Device not found', NOTIFICATION_ERROR_CODES.DEVICE_NOT_FOUND);
    }

    await this.deviceTokenRepository.deactivate(customerId, deviceId);

    logger.info('Customer device deactivated successfully', {
      customerId,
      deviceId,
    });

    return { success: true };
  }

  // ── Notification Lifecycle & Delivery ──────────────────────────────────────

  /**
   * Creates a notification record and dispatches FCM push notification.
   * Database persistence and push delivery are strictly decoupled:
   * push delivery failure never invalidates or rolls back the notification record.
   *
   * @param {object} params
   * @param {string} params.customerId
   * @param {string} params.type
   * @param {string} params.title
   * @param {string} params.body
   * @param {object} [params.data]
   * @param {string} [params.eventKey]
   * @param {string} [params.sound]
   * @param {string} [params.channelId]
   * @returns {Promise<object>}
   */
  async sendNotification({
    customerId,
    type,
    title,
    body,
    data = {},
    eventKey = null,
    sound,
    channelId,
  }) {
    // 1. Check idempotency: if eventKey exists, return existing without resending
    if (eventKey) {
      const existing = await this.notificationRepository.findByEventKey(eventKey);
      if (existing) {
        logger.info('Notification event already processed (idempotent)', {
          eventKey,
          notificationId: existing.id,
        });
        return existing;
      }
    }

    // 2. Persist notification to DB (always preserved)
    const notification = await this.notificationRepository.create({
      customerId,
      type,
      title,
      body,
      data,
      status: NOTIFICATION_STATUS.PENDING,
      eventKey,
    });

    // 3. Fetch active device tokens
    const activeDevices = await this.deviceTokenRepository.findActiveByCustomerId(customerId);

    if (!activeDevices || activeDevices.length === 0) {
      // Customer has no active device registered; mark as PENDING/history saved
      return notification;
    }

    const tokens = activeDevices.map((d) => d.deviceToken);

    // 4. Dispatch push notification via FCM provider
    try {
      const result = await this.provider.sendMulticast({
        tokens,
        title,
        body,
        data,
        sound,
        channelId,
      });

      // Cleanup invalid tokens reported by FCM
      if (Array.isArray(result.invalidTokens) && result.invalidTokens.length > 0) {
        this.deviceTokenRepository
          .deactivateByTokens(result.invalidTokens)
          .catch((err) => logger.warn('Failed to deactivate invalid tokens', { error: err.message }));
      }

      if (result.successCount > 0) {
        await this.notificationRepository.updateDeliveryStatus(notification.id, {
          status: NOTIFICATION_STATUS.SENT,
          sentAt: new Date().toISOString(),
        });
        notification.status = NOTIFICATION_STATUS.SENT;
        notification.sentAt = new Date().toISOString();
      } else {
        await this.notificationRepository.updateDeliveryStatus(notification.id, {
          status: NOTIFICATION_STATUS.FAILED,
          failureReason: result.reason || 'All device deliveries failed',
        });
        notification.status = NOTIFICATION_STATUS.FAILED;
      }
    } catch (err) {
      logger.error('Push notification delivery error', {
        notificationId: notification.id,
        error: err.message,
      });

      await this.notificationRepository.updateDeliveryStatus(notification.id, {
        status: NOTIFICATION_STATUS.FAILED,
        failureReason: err.message,
      }).catch(() => {});
      notification.status = NOTIFICATION_STATUS.FAILED;
    }

    return notification;
  }

  /**
   * Lists notifications for authenticated customer with pagination.
   *
   * @param {string} customerId
   * @param {object} query
   * @returns {Promise<object>}
   */
  async listNotifications(customerId, query) {
    return this.notificationRepository.findByCustomerId(customerId, query);
  }

  /**
   * Retrieves single notification ensuring customer ownership.
   *
   * @param {string} customerId
   * @param {string} notificationId
   * @returns {Promise<object>}
   */
  async getNotificationById(customerId, notificationId) {
    const notification = await this.notificationRepository.findByIdAndCustomerId(
      notificationId,
      customerId,
    );
    if (!notification) {
      throw new NotFoundError(
        'Notification not found',
        NOTIFICATION_ERROR_CODES.NOTIFICATION_NOT_FOUND,
      );
    }
    return notification;
  }

  /**
   * Marks a notification as read (idempotent).
   *
   * @param {string} customerId
   * @param {string} notificationId
   * @returns {Promise<object>}
   */
  async markAsRead(customerId, notificationId) {
    const notification = await this.getNotificationById(customerId, notificationId);
    return this.notificationRepository.markAsRead(notification.id, customerId);
  }

  /**
   * Marks all unread notifications for a customer as read.
   *
   * @param {string} customerId
   * @returns {Promise<{count: number}>}
   */
  async markAllAsRead(customerId) {
    const count = await this.notificationRepository.markAllAsRead(customerId);
    return { count };
  }

  /**
   * Counts unread notifications for customer.
   *
   * @param {string} customerId
   * @returns {Promise<{count: number}>}
   */
  async getUnreadCount(customerId) {
    const count = await this.notificationRepository.getUnreadCount(customerId);
    return { count };
  }
}

module.exports = new NotificationService();
