'use strict';

const express = require('express');
const adminCancellationRulesController = require('../controllers/cancellation-rules.controller');
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

/**
 * GET /api/v1/admin/cancellation-rules
 * Retrieves cancellation rules (supports optional ?vehicleType=bike|car).
 */
router.get(
  '/',
  requirePermission([
    PERMISSIONS.SETTINGS_READ,
    PERMISSIONS.SUPER_ADMIN,
  ]),
  (req, res, next) => adminCancellationRulesController.getCancellationRules(req, res, next),
);

const handleUpdate = (req, res, next) => {
  if (req.params.vehicleType && !req.body.vehicleType) {
    req.body.vehicleType = req.params.vehicleType;
  }
  return adminCancellationRulesController.updateCancellationRules(req, res, next);
};

/**
 * PUT /api/v1/admin/cancellation-rules
 * Updates cancellation rules (single vehicle or all vehicles).
 */
router.put(
  '/',
  sensitiveOpLimiter,
  requirePermission([
    PERMISSIONS.SETTINGS_UPDATE,
    PERMISSIONS.SUPER_ADMIN,
  ]),
  handleUpdate,
);

/**
 * PATCH /api/v1/admin/cancellation-rules
 * Alias for PUT.
 */
router.patch(
  '/',
  sensitiveOpLimiter,
  requirePermission([
    PERMISSIONS.SETTINGS_UPDATE,
    PERMISSIONS.SUPER_ADMIN,
  ]),
  handleUpdate,
);

/**
 * PUT /api/v1/admin/cancellation-rules/:vehicleType
 * Vehicle-specific update endpoint.
 */
router.put(
  '/:vehicleType',
  sensitiveOpLimiter,
  requirePermission([
    PERMISSIONS.SETTINGS_UPDATE,
    PERMISSIONS.SUPER_ADMIN,
  ]),
  handleUpdate,
);

module.exports = router;
