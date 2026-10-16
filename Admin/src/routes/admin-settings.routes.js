'use strict';

const express = require('express');
const adminSettingsController = require('../controllers/admin-settings.controller');
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/role');
const { requirePermission } = require('../middlewares/permission');
const { auditMiddleware } = require('../middlewares/audit');
const { sensitiveOpLimiter } = require('../middlewares/rateLimiter');
const { ROLES } = require('../constants/roles');
const { PERMISSIONS } = require('../constants/permissions');

const router = express.Router();

router.use(authenticate);
router.use(requireRole(ROLES.ADMIN));
router.use(auditMiddleware);

// GET /api/v1/admin/settings
router.get(
  '/',
  requirePermission([PERMISSIONS.SUPER_ADMIN, PERMISSIONS.DASHBOARD_READ]),
  (req, res, next) => adminSettingsController.getSettings(req, res, next),
);

// PATCH /api/v1/admin/settings
router.patch(
  '/',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.SUPER_ADMIN),
  (req, res, next) => adminSettingsController.updateSettings(req, res, next),
);

module.exports = router;
