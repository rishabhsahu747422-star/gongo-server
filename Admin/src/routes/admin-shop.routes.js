'use strict';

const express = require('express');
const adminShopController = require('../controllers/admin-shop.controller');
const { authenticate } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');
const { validatePagination } = require('../middleware/validate');
const { auditMiddleware } = require('../middlewares/audit');
const { sensitiveOpLimiter } = require('../middlewares/rateLimiter');
const { PERMISSIONS } = require('../constants/permissions');

const router = express.Router();

router.use(authenticate);
router.use(auditMiddleware);

// GET /api/v1/admin/shops
router.get(
  '/',
  authorize('admin', 'support_executive'),
  validatePagination,
  (req, res, next) => adminShopController.listShops(req, res, next),
);

// GET /api/v1/admin/shops/:id
router.get(
  '/:id',
  authorize('admin', 'support_executive'),
  (req, res, next) => adminShopController.getShopDetail(req, res, next),
);

// GET /api/v1/admin/shops/:id/documents
router.get(
  '/:id/documents',
  authorize('admin', 'support_executive'),
  (req, res, next) => adminShopController.getShopDocuments(req, res, next),
);

// GET /api/v1/admin/shops/:id/images
router.get(
  '/:id/images',
  authorize('admin', 'support_executive'),
  (req, res, next) => adminShopController.getShopImages(req, res, next),
);

// GET /api/v1/admin/shops/:id/operating-hours
router.get(
  '/:id/operating-hours',
  authorize('admin', 'support_executive'),
  (req, res, next) => adminShopController.getShopOperatingHours(req, res, next),
);

// GET /api/v1/admin/shops/:id/vehicles
router.get(
  '/:id/vehicles',
  authorize('admin', 'support_executive'),
  (req, res, next) => adminShopController.getShopVehicles(req, res, next),
);

// PATCH /api/v1/admin/shops/:id/verify
router.patch(
  '/:id/verify',
  sensitiveOpLimiter,
  authorize('admin'),
  (req, res, next) => adminShopController.verifyShop(req, res, next),
);

// PATCH /api/v1/admin/shops/:id/reject
router.patch(
  '/:id/reject',
  sensitiveOpLimiter,
  authorize('admin'),
  (req, res, next) => adminShopController.rejectShop(req, res, next),
);

// PATCH /api/v1/admin/shops/:id/suspend
router.patch(
  '/:id/suspend',
  sensitiveOpLimiter,
  authorize('admin'),
  (req, res, next) => adminShopController.suspendShop(req, res, next),
);

// PATCH /api/v1/admin/shops/:id/reactivate
router.patch(
  '/:id/reactivate',
  sensitiveOpLimiter,
  authorize('admin'),
  (req, res, next) => adminShopController.reactivateShop(req, res, next),
);

// PATCH /api/v1/admin/shops/:id/status
router.patch(
  '/:id/status',
  sensitiveOpLimiter,
  authorize('admin'),
  (req, res, next) => adminShopController.updateShopStatus(req, res, next),
);

module.exports = router;
