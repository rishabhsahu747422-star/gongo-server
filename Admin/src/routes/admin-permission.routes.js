'use strict';

const express = require('express');
const adminPermissionController = require('../controllers/admin-permission.controller');
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/role');
const { requirePermission } = require('../middlewares/permission');
const { auditMiddleware } = require('../middlewares/audit');
const { sensitiveOpLimiter } = require('../middlewares/rateLimiter');
const { ROLES } = require('../constants/roles');
const { PERMISSIONS } = require('../constants/permissions');

const router = express.Router();

// All permission routes require authentication, ADMIN role, and audit context
router.use(authenticate);
router.use(requireRole(ROLES.ADMIN));
router.use(auditMiddleware);

// ── Read Operations ─────────────────────────────────────────────────────────

// GET /api/v1/admin/permissions
// Lists the canonical permission catalog (read-only reference)
router.get(
  '/',
  requirePermission([PERMISSIONS.ADMIN_PERMISSIONS_MANAGE, PERMISSIONS.ADMIN_USERS_READ]),
  (req, res, next) => {
    adminPermissionController.listAvailablePermissions(req, res, next);
  },
);

// GET /api/v1/admin/permissions/:userId
// Gets all permissions assigned to a specific admin user
router.get(
  '/:userId',
  requirePermission([PERMISSIONS.ADMIN_PERMISSIONS_MANAGE, PERMISSIONS.ADMIN_USERS_READ]),
  (req, res, next) => {
    adminPermissionController.getUserPermissions(req, res, next);
  },
);

// ── Mutation Operations (rate-limited) ──────────────────────────────────────

// POST /api/v1/admin/permissions/grant
// Grants a permission to a target admin user
router.post(
  '/grant',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.ADMIN_PERMISSIONS_MANAGE),
  (req, res, next) => {
    adminPermissionController.grantPermission(req, res, next);
  },
);

// POST /api/v1/admin/permissions/revoke
// Revokes a permission from a target admin user
router.post(
  '/revoke',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.ADMIN_PERMISSIONS_MANAGE),
  (req, res, next) => {
    adminPermissionController.revokePermission(req, res, next);
  },
);

module.exports = router;
