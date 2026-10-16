'use strict';

const NotificationRepository = require('../repositories/notification.repository');
const { NotFoundError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

class NotificationService {
  constructor(notificationRepo = new NotificationRepository()) {
    this.notificationRepository = notificationRepo;
  }

  /**
   * Retrieves paginated notifications for partner.
   *
   * @param {string} partnerId
   * @param {object} options
   * @returns {Promise<object>}
   */
  async getNotifications(partnerId, options = {}) {
    const { rows, total } = await this.notificationRepository.findPaginatedByPartnerId(
      partnerId,
      options,
    );

    const items = rows.map((row) => ({
      id: row.id,
      partnerId: row.partner_id,
      type: row.type,
      title: row.title,
      body: row.body,
      message: row.body,
      unread: row.read_at === null,
      payload: row.payload || {},
      readAt: row.read_at,
      isRead: row.read_at !== null,
      eventKey: row.event_key,
      createdAt: row.created_at,
    }));

    const page = options.page || 1;
    const limit = options.limit || 20;
    const totalPages = Math.ceil(total / limit) || 1;

    return {
      items,
      pagination: {
        page,
        limit,
        totalItems: total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * Retrieves count of unread notifications for partner.
   *
   * @param {string} partnerId
   * @returns {Promise<{ unreadCount: number }>}
   */
  async getUnreadCount(partnerId) {
    const unreadCount = await this.notificationRepository.getUnreadCountByPartnerId(partnerId);
    return { unreadCount };
  }

  /**
   * Marks single notification as read (with BOLA check).
   *
   * @param {string} partnerId
   * @param {string} notificationId
   * @returns {Promise<object>}
   */
  async markAsRead(partnerId, notificationId) {
    const updated = await this.notificationRepository.markAsReadByIdAndPartnerId(
      notificationId,
      partnerId,
    );

    if (!updated) {
      throw new NotFoundError(
        'Notification not found or unauthorized',
        ERROR_CODES.NOT_FOUND,
      );
    }

    return {
      id: updated.id,
      partnerId: updated.partner_id,
      type: updated.type,
      title: updated.title,
      body: updated.body,
      payload: updated.payload || {},
      readAt: updated.read_at,
      isRead: true,
      createdAt: updated.created_at,
    };
  }

  /**
   * Marks all notifications as read for partner.
   *
   * @param {string} partnerId
   * @returns {Promise<{ updatedCount: number }>}
   */
  async markAllAsRead(partnerId) {
    const updatedCount = await this.notificationRepository.markAllAsReadByPartnerId(partnerId);
    return { updatedCount };
  }

  /**
   * Registers/updates partner FCM device token for push notifications.
   *
   * @param {string} partnerId
   * @param {object} payload
   * @param {string} payload.token
   * @param {string} [payload.platform='android']
   * @returns {Promise<object>}
   */
  async registerDeviceToken(partnerId, payload) {
    const { token, platform = 'android' } = payload;
    const record = await this.notificationRepository.upsertDeviceToken(
      partnerId,
      token,
      platform,
    );
    return {
      id: record.id,
      partnerId: record.partner_id,
      platform: record.platform,
      isActive: record.is_active,
      updatedAt: record.updated_at,
    };
  }

  /**
   * Removes partner FCM device token on logout.
   *
   * @param {string} partnerId
   * @param {object} payload
   * @param {string} payload.token
   * @returns {Promise<{ removed: boolean }>}
   */
  async removeDeviceToken(partnerId, payload) {
    const { token } = payload;
    const removed = await this.notificationRepository.removeDeviceToken(partnerId, token);
    return { removed };
  }

  /**
   * Helper to dispatch in-app notification.
   *
   * @param {object} params
   * @returns {Promise<object|null>}
   */
  async dispatchNotification(params, client = null) {
    return this.notificationRepository.createNotification(params, client);
  }
}

module.exports = new NotificationService();
