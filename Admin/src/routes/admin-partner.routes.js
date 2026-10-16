'use strict';

const express = require('express');
const adminPartnerController = require('../controllers/admin-partner.controller');
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

// GET /api/v1/admin/partners (List partners with search/filter/pagination)
router.get(
  '/',
  requirePermission(PERMISSIONS.PARTNERS_READ),
  (req, res, next) => adminPartnerController.listPartners(req, res, next),
);

// GET /api/v1/admin/partners/:id (Partner detail with fleet, bookings, kyc summaries)
router.get(
  '/:id',
  requirePermission(PERMISSIONS.PARTNERS_READ),
  (req, res, next) => adminPartnerController.getPartnerDetail(req, res, next),
);

// GET /api/v1/admin/partners/:id/documents (Partner verification documents)
router.get(
  '/:id/documents',
  requirePermission(PERMISSIONS.PARTNERS_READ),
  (req, res, next) => adminPartnerController.getPartnerDocuments(req, res, next),
);

// GET /api/v1/admin/partners/:id/kyc (Partner KYC status and verification breakdown)
router.get(
  '/:id/kyc',
  requirePermission(PERMISSIONS.PARTNERS_READ),
  (req, res, next) => adminPartnerController.getPartnerKyc(req, res, next),
);

// GET /api/v1/admin/partners/:id/bank-accounts (Partner bank accounts with masked numbers)
router.get(
  '/:id/bank-accounts',
  requirePermission(PERMISSIONS.PARTNERS_READ),
  (req, res, next) => adminPartnerController.getPartnerBankAccounts(req, res, next),
);

// GET /api/v1/admin/partners/:id/shops (Partner legacy shops)
router.get(
  '/:id/shops',
  requirePermission(PERMISSIONS.PARTNERS_READ),
  (req, res, next) => adminPartnerController.getPartnerShops(req, res, next),
);

// GET /api/v1/admin/partners/:id/vehicles (Partner vehicle fleet with pagination)
router.get(
  '/:id/vehicles',
  requirePermission(PERMISSIONS.PARTNERS_READ),
  (req, res, next) => adminPartnerController.getPartnerVehicles(req, res, next),
);

// GET /api/v1/admin/partners/:id/bookings (Partner bookings history with pagination)
router.get(
  '/:id/bookings',
  requirePermission(PERMISSIONS.PARTNERS_READ),
  (req, res, next) => adminPartnerController.getPartnerBookings(req, res, next),
);

// GET /api/v1/admin/partners/:id/earnings (Partner financial/earnings summary)
router.get(
  '/:id/earnings',
  requirePermission(PERMISSIONS.PARTNERS_READ),
  (req, res, next) => adminPartnerController.getPartnerEarnings(req, res, next),
);

// GET /api/v1/admin/partners/:id/verification-history (Partner verification audit history)
router.get(
  '/:id/verification-history',
  requirePermission(PERMISSIONS.PARTNERS_READ),
  (req, res, next) => adminPartnerController.getPartnerVerificationHistory(req, res, next),
);

// ── Mutation Operations ─────────────────────────────────────────────────────

// PATCH /api/v1/admin/partners/:id/status (Update partner active / operational status)
router.patch(
  '/:id/status',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.PARTNERS_UPDATE),
  (req, res, next) => adminPartnerController.updatePartnerStatus(req, res, next),
);

// PATCH /api/v1/admin/partners/:id/verify & POST /api/v1/admin/partners/:id/approve
router.patch(
  '/:id/verify',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.PARTNERS_VERIFY),
  (req, res, next) => adminPartnerController.approvePartner(req, res, next),
);
router.post(
  '/:id/approve',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.PARTNERS_VERIFY),
  (req, res, next) => adminPartnerController.approvePartner(req, res, next),
);

// PATCH /api/v1/admin/partners/:id/reject & POST /api/v1/admin/partners/:id/reject
router.patch(
  '/:id/reject',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.PARTNERS_VERIFY),
  (req, res, next) => adminPartnerController.rejectPartner(req, res, next),
);
router.post(
  '/:id/reject',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.PARTNERS_VERIFY),
  (req, res, next) => adminPartnerController.rejectPartner(req, res, next),
);

// PATCH /api/v1/admin/partners/:id/suspend
router.patch(
  '/:id/suspend',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.PARTNERS_UPDATE),
  (req, res, next) => adminPartnerController.suspendPartner(req, res, next),
);

// PATCH /api/v1/admin/partners/:id/reactivate
router.patch(
  '/:id/reactivate',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.PARTNERS_UPDATE),
  (req, res, next) => adminPartnerController.reactivatePartner(req, res, next),
);

module.exports = router;
