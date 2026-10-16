'use strict';

const notificationService = require('../services/notification.service');
const { sendSuccess } = require('../utils/response');
const { HTTP_STATUS } = require('../constants/http');

class NotificationController {
  /**
   * GET /api/v1/partner/notifications
   * List paginated notifications for authenticated partner.
   */
  async getNotifications(req, res, next) {
    try {
      const { partnerId } = req.user;
      const result = await notificationService.getNotifications(partnerId, req.validatedQuery);
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/partner/notifications/unread-count
   * Get unread notification count.
   */
  async getUnreadCount(req, res, next) {
    try {
      const { partnerId } = req.user;
      const result = await notificationService.getUnreadCount(partnerId);
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/partner/notifications/:notificationId/read
   * Mark notification as read.
   */
  async markAsRead(req, res, next) {
    try {
      const { partnerId } = req.user;
      const { notificationId } = req.params;
      const result = await notificationService.markAsRead(partnerId, notificationId);
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/partner/notifications/read-all
   * Mark all notifications as read.
   */
  async markAllAsRead(req, res, next) {
    try {
      const { partnerId } = req.user;
      const result = await notificationService.markAllAsRead(partnerId);
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/partner/notifications/device-token
   * Register/update FCM device token.
   */
  async registerDeviceToken(req, res, next) {
    try {
      const { partnerId } = req.user;
      const result = await notificationService.registerDeviceToken(partnerId, req.validatedBody);
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * DELETE /api/v1/partner/notifications/device-token
   * Remove FCM device token.
   */
  async removeDeviceToken(req, res, next) {
    try {
      const { partnerId } = req.user;
      const result = await notificationService.removeDeviceToken(partnerId, req.validatedBody);
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new NotificationController();
