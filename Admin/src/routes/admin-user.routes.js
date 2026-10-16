'use strict';

const express = require('express');
const adminUserController = require('../controllers/admin-user.controller');
const { authenticate } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');
const { requirePermission } = require('../middlewares/permission');
const { PERMISSIONS } = require('../constants/permissions');
const { validatePagination } = require('../middleware/validate');
const { auditMiddleware } = require('../middlewares/audit');
const { sensitiveOpLimiter } = require('../middlewares/rateLimiter');

const router = express.Router();

router.use(authenticate);
router.use(auditMiddleware);

// GET /api/admin/users
router.get(
  '/',
  authorize('admin', 'support_executive'),
  validatePagination,
  (req, res, next) => adminUserController.listUsers(req, res, next),
);

// GET /api/admin/users/:id
router.get(
  '/:id',
  authorize('admin', 'support_executive'),
  (req, res, next) => adminUserController.getUserById(req, res, next),
);

// PATCH /api/admin/users/:id/status
router.patch(
  '/:id/status',
  sensitiveOpLimiter,
  authorize('admin'),
  requirePermission(PERMISSIONS.ADMIN_USERS_UPDATE),
  (req, res, next) => adminUserController.updateUserStatus(req, res, next),
);

// PATCH /api/admin/users/:id/role
router.patch(
  '/:id/role',
  sensitiveOpLimiter,
  authorize('admin'),
  requirePermission(PERMISSIONS.ADMIN_PERMISSIONS_MANAGE),
  (req, res, next) => adminUserController.updateUserRole(req, res, next),
);

// POST /api/admin/users
router.post(
  '/',
  sensitiveOpLimiter,
  authorize('admin', 'super_admin'),
  requirePermission(PERMISSIONS.ADMIN_USERS_CREATE),
  (req, res, next) => adminUserController.createUser(req, res, next),
);

module.exports = router;
