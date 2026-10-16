'use strict';

const notificationService = require('../services/notification.service');
const { sendSuccess } = require('../utils/response');
const { HTTP_STATUS } = require('../constants/http');

/**
 * NotificationController — HTTP adapter for customer devices and notifications.
 */
class NotificationController {
  /**
   * POST /api/v1/customers/me/devices
   */
  async registerDevice(req, res, next) {
    try {
      const device = await notificationService.registerDevice(req.user.id, req.body);
      return sendSuccess(
        res,
        { device },
        'Device registered successfully',
        HTTP_STATUS.CREATED,
      );
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/customers/me/devices
   */
  async listDevices(req, res, next) {
    try {
      const devices = await notificationService.listDevices(req.user.id);
      return sendSuccess(
        res,
        { devices },
        'Devices retrieved successfully',
        HTTP_STATUS.OK,
      );
    } catch (err) {
      return next(err);
    }
  }

  /**
   * DELETE /api/v1/customers/me/devices/:deviceId
   */
  async removeDevice(req, res, next) {
    try {
      const { deviceId } = req.params;
      await notificationService.removeDevice(req.user.id, deviceId);
      return sendSuccess(
        res,
        null,
        'Device removed successfully',
        HTTP_STATUS.OK,
      );
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/customers/me/notifications
   */
  async listNotifications(req, res, next) {
    try {
      const result = await notificationService.listNotifications(req.user.id, req.query);
      return sendSuccess(
        res,
        result,
        'Notifications retrieved successfully',
        HTTP_STATUS.OK,
      );
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/customers/me/notifications/unread-count
   */
  async getUnreadCount(req, res, next) {
    try {
      const result = await notificationService.getUnreadCount(req.user.id);
      return sendSuccess(
        res,
        result,
        'Unread count retrieved successfully',
        HTTP_STATUS.OK,
      );
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/customers/me/notifications/read-all
   */
  async markAllAsRead(req, res, next) {
    try {
      const result = await notificationService.markAllAsRead(req.user.id);
      return sendSuccess(
        res,
        result,
        'All notifications marked as read',
        HTTP_STATUS.OK,
      );
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/customers/me/notifications/:notificationId
   */
  async getNotification(req, res, next) {
    try {
      const { notificationId } = req.params;
      const notification = await notificationService.getNotificationById(
        req.user.id,
        notificationId,
      );
      return sendSuccess(
        res,
        { notification },
        'Notification retrieved successfully',
        HTTP_STATUS.OK,
      );
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/customers/me/notifications/:notificationId/read
   */
  async markAsRead(req, res, next) {
    try {
      const { notificationId } = req.params;
      const notification = await notificationService.markAsRead(
        req.user.id,
        notificationId,
      );
      return sendSuccess(
        res,
        { notification },
        'Notification marked as read',
        HTTP_STATUS.OK,
      );
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new NotificationController();
