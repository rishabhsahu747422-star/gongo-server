'use strict';

const express = require('express');
const adminVehicleController = require('../controllers/admin-vehicle.controller');
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/role');
const { requirePermission } = require('../middlewares/permission');
const { auditMiddleware } = require('../middlewares/audit');
const { sensitiveOpLimiter } = require('../middlewares/rateLimiter');
const { ROLES } = require('../constants/roles');
const { PERMISSIONS } = require('../constants/permissions');

const router = express.Router();

// Defense-in-depth: Require authenticated session, authoritative ADMIN role, and audit context
router.use(authenticate);
router.use(requireRole(ROLES.ADMIN));
router.use(auditMiddleware);

// ── Read Operations ─────────────────────────────────────────────────────────

// GET /api/v1/admin/vehicles (List vehicles with search/filter/pagination)
router.get(
  '/',
  requirePermission(PERMISSIONS.VEHICLES_READ),
  (req, res, next) => adminVehicleController.listVehicles(req, res, next),
);

// GET /api/v1/admin/vehicles/:id (Vehicle detail view + operational summaries)
router.get(
  '/:id',
  requirePermission(PERMISSIONS.VEHICLES_READ),
  (req, res, next) => adminVehicleController.getVehicleDetail(req, res, next),
);

// GET /api/v1/admin/vehicles/:id/documents (Vehicle verification documents metadata)
router.get(
  '/:id/documents',
  requirePermission(PERMISSIONS.VEHICLES_READ),
  (req, res, next) => adminVehicleController.getVehicleDocuments(req, res, next),
);

// GET /api/v1/admin/vehicles/:id/documents/:documentId (Specific vehicle document with ownership check)
router.get(
  '/:id/documents/:documentId',
  requirePermission(PERMISSIONS.VEHICLES_READ),
  (req, res, next) => adminVehicleController.getVehicleDocumentDetail(req, res, next),
);

// GET /api/v1/admin/vehicles/:id/images (Vehicle gallery images)
router.get(
  '/:id/images',
  requirePermission(PERMISSIONS.VEHICLES_READ),
  (req, res, next) => adminVehicleController.getVehicleImages(req, res, next),
);

// GET /api/v1/admin/vehicles/:id/bookings (Vehicle bookings history with pagination)
router.get(
  '/:id/bookings',
  requirePermission(PERMISSIONS.VEHICLES_READ),
  (req, res, next) => adminVehicleController.getVehicleBookings(req, res, next),
);

// GET /api/v1/admin/vehicles/:id/availability (Vehicle availability blocks and rental status)
router.get(
  '/:id/availability',
  requirePermission(PERMISSIONS.VEHICLES_READ),
  (req, res, next) => adminVehicleController.getVehicleAvailability(req, res, next),
);

// GET /api/v1/admin/vehicles/:id/pricing (Vehicle pricing rates)
router.get(
  '/:id/pricing',
  requirePermission(PERMISSIONS.VEHICLES_READ),
  (req, res, next) => adminVehicleController.getVehiclePricing(req, res, next),
);

// GET /api/v1/admin/vehicles/:id/earnings (Vehicle financial / earnings summary)
router.get(
  '/:id/earnings',
  requirePermission(PERMISSIONS.VEHICLES_READ),
  (req, res, next) => adminVehicleController.getVehicleEarnings(req, res, next),
);

// GET /api/v1/admin/vehicles/:id/history (Vehicle administrative audit trail)
router.get(
  '/:id/history',
  requirePermission(PERMISSIONS.VEHICLES_READ),
  (req, res, next) => adminVehicleController.getVehicleHistory(req, res, next),
);

// ── Mutation Operations ─────────────────────────────────────────────────────

// PATCH /api/v1/admin/vehicles/:id/status (Update vehicle operational status & archival)
router.patch(
  '/:id/status',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.VEHICLES_UPDATE),
  (req, res, next) => adminVehicleController.updateVehicleStatus(req, res, next),
);

// PATCH /api/v1/admin/vehicles/:id/verification (Update verification status directly)
router.patch(
  '/:id/verification',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.VEHICLES_VERIFY),
  (req, res, next) => adminVehicleController.updateVehicleVerification(req, res, next),
);

// PATCH /api/v1/admin/vehicles/:id/verify & POST /api/v1/admin/vehicles/:id/approve
router.patch(
  '/:id/verify',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.VEHICLES_VERIFY),
  (req, res, next) => adminVehicleController.approveVehicle(req, res, next),
);
router.post(
  '/:id/approve',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.VEHICLES_VERIFY),
  (req, res, next) => adminVehicleController.approveVehicle(req, res, next),
);

// PATCH /api/v1/admin/vehicles/:id/reject & POST /api/v1/admin/vehicles/:id/reject
router.patch(
  '/:id/reject',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.VEHICLES_VERIFY),
  (req, res, next) => adminVehicleController.rejectVehicle(req, res, next),
);
router.post(
  '/:id/reject',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.VEHICLES_VERIFY),
  (req, res, next) => adminVehicleController.rejectVehicle(req, res, next),
);

// PATCH /api/v1/admin/vehicles/:id/block
router.patch(
  '/:id/block',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.VEHICLES_UPDATE),
  (req, res, next) => adminVehicleController.blockVehicle(req, res, next),
);

// PATCH /api/v1/admin/vehicles/:id/activate
router.patch(
  '/:id/activate',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.VEHICLES_UPDATE),
  (req, res, next) => adminVehicleController.activateVehicle(req, res, next),
);

// PATCH /api/v1/admin/vehicles/:id/deactivate
router.patch(
  '/:id/deactivate',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.VEHICLES_UPDATE),
  (req, res, next) => adminVehicleController.deactivateVehicle(req, res, next),
);

module.exports = router;
