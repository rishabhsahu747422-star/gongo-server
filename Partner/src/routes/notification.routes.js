'use strict';

const express = require('express');
const notificationController = require('../controllers/notification.controller');
const notificationValidator = require('../validators/notification.validator');
const { createRateLimiter } = require('../middlewares/rateLimiter');

const router = express.Router();

const notificationReadLimiter = createRateLimiter({
  max: 60,
  windowMs: 60 * 1000,
  prefix: 'rl:partner:notifications:read',
});

const notificationMutationLimiter = createRateLimiter({
  max: 30,
  windowMs: 60 * 1000,
  prefix: 'rl:partner:notifications:write',
});

/**
 * @route   GET /api/v1/partner/notifications
 * @desc    List paginated notifications for authenticated partner.
 * @access  Private (Partner)
 */
router.get(
  '/',
  notificationReadLimiter,
  (req, res, next) => notificationValidator.validateNotificationListQuery(req, res, next),
  (req, res, next) => notificationController.getNotifications(req, res, next),
);

/**
 * @route   GET /api/v1/partner/notifications/unread-count
 * @desc    Get count of unread notifications.
 * @access  Private (Partner)
 */
router.get(
  '/unread-count',
  notificationReadLimiter,
  (req, res, next) => notificationController.getUnreadCount(req, res, next),
);

/**
 * @route   PATCH /api/v1/partner/notifications/:notificationId/read
 * @desc    Mark single notification as read.
 * @access  Private (Partner)
 */
router.patch(
  '/:notificationId/read',
  notificationMutationLimiter,
  (req, res, next) => notificationValidator.validateNotificationIdParam(req, res, next),
  (req, res, next) => notificationController.markAsRead(req, res, next),
);

/**
 * @route   PATCH /api/v1/partner/notifications/read-all
 * @desc    Mark all unread notifications as read.
 * @access  Private (Partner)
 */
router.patch(
  '/read-all',
  notificationMutationLimiter,
  (req, res, next) => notificationController.markAllAsRead(req, res, next),
);

router.post(
  '/read-all',
  notificationMutationLimiter,
  (req, res, next) => notificationController.markAllAsRead(req, res, next),
);

router.patch(
  '/mark-all-read',
  notificationMutationLimiter,
  (req, res, next) => notificationController.markAllAsRead(req, res, next),
);

router.post(
  '/mark-all-read',
  notificationMutationLimiter,
  (req, res, next) => notificationController.markAllAsRead(req, res, next),
);

/**
 * @route   POST /api/v1/partner/notifications/device-token
 * @desc    Register or update partner device token for FCM push notifications.
 * @access  Private (Partner)
 */
router.post(
  '/device-token',
  notificationMutationLimiter,
  (req, res, next) => notificationValidator.validateDeviceTokenPayload(req, res, next),
  (req, res, next) => notificationController.registerDeviceToken(req, res, next),
);

/**
 * @route   DELETE /api/v1/partner/notifications/device-token
 * @desc    Remove device token on logout.
 * @access  Private (Partner)
 */
router.delete(
  '/device-token',
  notificationMutationLimiter,
  (req, res, next) => notificationValidator.validateRemoveTokenPayload(req, res, next),
  (req, res, next) => notificationController.removeDeviceToken(req, res, next),
);

module.exports = router;
