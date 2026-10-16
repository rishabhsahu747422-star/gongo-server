'use strict';

const express = require('express');
const adminPlatformFeeController = require('../controllers/admin-platform-fee.controller');
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/role');
const { requirePermission } = require('../middlewares/permission');
const { auditMiddleware } = require('../middlewares/audit');
const { sensitiveOpLimiter } = require('../middlewares/rateLimiter');
const { ROLES } = require('../constants/roles');
const { PERMISSIONS } = require('../constants/permissions');

const router = express.Router();

// Base administrative route guards
router.use(authenticate);
router.use(requireRole(ROLES.ADMIN));
router.use(auditMiddleware);

/**
 * GET /api/v1/admin/platform-fee
 * Retrieves active platform fee configuration.
 *
 * RBAC: Accessible by Super Admin, Finance Admin, or admins with settings/platform_fee read.
 */
router.get(
  '/',
  requirePermission([
    PERMISSIONS.PLATFORM_FEE_READ,
    PERMISSIONS.SETTINGS_READ,
    PERMISSIONS.COMMISSIONS_READ,
    PERMISSIONS.SUPER_ADMIN,
  ]),
  (req, res, next) => adminPlatformFeeController.getPlatformFee(req, res, next),
);

const handleUpdate = (req, res, next) => (
  adminPlatformFeeController.updatePlatformFee(req, res, next)
);

/**
 * PUT /api/v1/admin/platform-fee
 * Updates active platform fee configuration.
 */
router.put(
  '/',
  sensitiveOpLimiter,
  requirePermission([
    PERMISSIONS.PLATFORM_FEE_UPDATE,
    PERMISSIONS.SETTINGS_UPDATE,
    PERMISSIONS.COMMISSIONS_UPDATE,
    PERMISSIONS.SUPER_ADMIN,
  ]),
  handleUpdate,
);

/**
 * PATCH /api/v1/admin/platform-fee
 * Updates active platform fee configuration.
 */
router.patch(
  '/',
  sensitiveOpLimiter,
  requirePermission([
    PERMISSIONS.PLATFORM_FEE_UPDATE,
    PERMISSIONS.SETTINGS_UPDATE,
    PERMISSIONS.COMMISSIONS_UPDATE,
    PERMISSIONS.SUPER_ADMIN,
  ]),
  handleUpdate,
);

/**
 * GET /api/v1/admin/platform-fee/:vehicleType
 * Retrieves active platform fee configuration for a specific vehicle type ('bike' | 'car').
 */
router.get(
  '/:vehicleType',
  requirePermission([
    PERMISSIONS.PLATFORM_FEE_READ,
    PERMISSIONS.SETTINGS_READ,
    PERMISSIONS.COMMISSIONS_READ,
    PERMISSIONS.SUPER_ADMIN,
  ]),
  (req, res, next) => adminPlatformFeeController.getPlatformFee(req, res, next),
);

/**
 * PUT /api/v1/admin/platform-fee/:vehicleType
 * Updates active platform fee configuration for a specific vehicle type ('bike' | 'car').
 */
router.put(
  '/:vehicleType',
  sensitiveOpLimiter,
  requirePermission([
    PERMISSIONS.PLATFORM_FEE_UPDATE,
    PERMISSIONS.SETTINGS_UPDATE,
    PERMISSIONS.COMMISSIONS_UPDATE,
    PERMISSIONS.SUPER_ADMIN,
  ]),
  handleUpdate,
);

/**
 * PATCH /api/v1/admin/platform-fee/:vehicleType
 * Updates active platform fee configuration for a specific vehicle type ('bike' | 'car').
 */
router.patch(
  '/:vehicleType',
  sensitiveOpLimiter,
  requirePermission([
    PERMISSIONS.PLATFORM_FEE_UPDATE,
    PERMISSIONS.SETTINGS_UPDATE,
    PERMISSIONS.COMMISSIONS_UPDATE,
    PERMISSIONS.SUPER_ADMIN,
  ]),
  handleUpdate,
);

module.exports = router;
