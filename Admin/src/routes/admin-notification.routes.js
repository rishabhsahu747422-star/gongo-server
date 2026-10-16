'use strict';

const express = require('express');
const adminNotificationController = require('../controllers/admin-notification.controller');
const { requirePermission } = require('../middlewares/permission');
const { sensitiveOpLimiter } = require('../middlewares/rateLimiter');
const { PERMISSIONS } = require('../constants/permissions');

const notificationRouter = express.Router();

// ── 1. Notification Templates Endpoints (Declared before /:id) ────────────────

notificationRouter.get(
  '/templates',
  requirePermission(PERMISSIONS.NOTIFICATIONS_READ),
  (req, res, next) => adminNotificationController.listTemplates(req, res, next),
);

notificationRouter.post(
  '/templates',
  requirePermission([PERMISSIONS.NOTIFICATIONS_MANAGE, PERMISSIONS.NOTIFICATIONS_SEND]),
  sensitiveOpLimiter,
  (req, res, next) => adminNotificationController.createTemplate(req, res, next),
);

notificationRouter.get(
  '/templates/:id',
  requirePermission(PERMISSIONS.NOTIFICATIONS_READ),
  (req, res, next) => adminNotificationController.getTemplateById(req, res, next),
);

notificationRouter.patch(
  '/templates/:id',
  requirePermission([PERMISSIONS.NOTIFICATIONS_MANAGE, PERMISSIONS.NOTIFICATIONS_SEND]),
  sensitiveOpLimiter,
  (req, res, next) => adminNotificationController.updateTemplate(req, res, next),
);

notificationRouter.post(
  '/templates/:id/activate',
  requirePermission([PERMISSIONS.NOTIFICATIONS_MANAGE, PERMISSIONS.NOTIFICATIONS_SEND]),
  sensitiveOpLimiter,
  (req, res, next) => adminNotificationController.activateTemplate(req, res, next),
);

notificationRouter.post(
  '/templates/:id/deactivate',
  requirePermission([PERMISSIONS.NOTIFICATIONS_MANAGE, PERMISSIONS.NOTIFICATIONS_SEND]),
  sensitiveOpLimiter,
  (req, res, next) => adminNotificationController.deactivateTemplate(req, res, next),
);

// ── 2. Notification Dispatch & Broadcast ──────────────────────────────────────

notificationRouter.post(
  '/send',
  requirePermission(PERMISSIONS.NOTIFICATIONS_SEND),
  sensitiveOpLimiter,
  (req, res, next) => adminNotificationController.sendNotification(req, res, next),
);

notificationRouter.post(
  '/',
  requirePermission(PERMISSIONS.NOTIFICATIONS_SEND),
  sensitiveOpLimiter,
  (req, res, next) => adminNotificationController.sendNotification(req, res, next),
);

// ── 3. Notification Querying & Detail ─────────────────────────────────────────

notificationRouter.get(
  '/',
  requirePermission(PERMISSIONS.NOTIFICATIONS_READ),
  (req, res, next) => adminNotificationController.listNotifications(req, res, next),
);

notificationRouter.get(
  '/:id/status',
  requirePermission(PERMISSIONS.NOTIFICATIONS_READ),
  (req, res, next) => adminNotificationController.getNotificationStatus(req, res, next),
);

notificationRouter.post(
  '/:id/send',
  requirePermission(PERMISSIONS.NOTIFICATIONS_SEND),
  sensitiveOpLimiter,
  (req, res, next) => adminNotificationController.retryNotification(req, res, next),
);

notificationRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.NOTIFICATIONS_READ),
  (req, res, next) => adminNotificationController.getNotificationById(req, res, next),
);

module.exports = notificationRouter;
