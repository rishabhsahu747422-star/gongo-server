'use strict';

const express = require('express');
const adminVerificationController = require('../controllers/admin-verification.controller');
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

// ── Unified KYC Queue ──────────────────────────────────────────────────────

// GET /api/v1/admin/verifications/kyc (Unified queue across partners and vehicles)
router.get(
  '/kyc',
  requirePermission(PERMISSIONS.KYC_READ),
  (req, res, next) => adminVerificationController.listKyc(req, res, next),
);

// GET /api/v1/admin/verifications (Root index mapping to unified KYC queue)
router.get(
  '/',
  requirePermission(PERMISSIONS.KYC_READ),
  (req, res, next) => adminVerificationController.listKyc(req, res, next),
);

// ── Partner Verification Routes (Architecture Section 15) ───────────────────

// GET /api/v1/admin/verifications/partners (List partners with verification/KYC status)
router.get(
  '/partners',
  requirePermission([PERMISSIONS.KYC_READ, PERMISSIONS.PARTNERS_READ]),
  (req, res, next) => adminVerificationController.listPartnerVerifications(req, res, next),
);

// GET /api/v1/admin/verifications/partners/:id (Partner verification detail view)
router.get(
  '/partners/:id',
  requirePermission([PERMISSIONS.KYC_READ, PERMISSIONS.PARTNERS_READ]),
  (req, res, next) => adminVerificationController.getPartnerVerificationDetail(req, res, next),
);

// POST /api/v1/admin/verifications/partners/:id/approve (Approve partner KYC)
router.post(
  '/partners/:id/approve',
  sensitiveOpLimiter,
  requirePermission([PERMISSIONS.KYC_VERIFY, PERMISSIONS.PARTNERS_VERIFY]),
  (req, res, next) => adminVerificationController.approvePartner(req, res, next),
);

// POST /api/v1/admin/verifications/partners/:id/reject (Reject partner KYC with mandatory reason)
router.post(
  '/partners/:id/reject',
  sensitiveOpLimiter,
  requirePermission([PERMISSIONS.KYC_REJECT, PERMISSIONS.PARTNERS_VERIFY]),
  (req, res, next) => adminVerificationController.rejectPartner(req, res, next),
);

// ── Vehicle Verification Routes (Architecture Section 15) ───────────────────

// GET /api/v1/admin/verifications/vehicles (List vehicles with verification status)
router.get(
  '/vehicles',
  requirePermission([PERMISSIONS.KYC_READ, PERMISSIONS.VEHICLES_READ]),
  (req, res, next) => adminVerificationController.listVehicleVerifications(req, res, next),
);

// GET /api/v1/admin/verifications/vehicles/:id (Vehicle verification detail view)
router.get(
  '/vehicles/:id',
  requirePermission([PERMISSIONS.KYC_READ, PERMISSIONS.VEHICLES_READ]),
  (req, res, next) => adminVerificationController.getVehicleVerificationDetail(req, res, next),
);

// POST /api/v1/admin/verifications/vehicles/:id/approve (Approve vehicle verification)
router.post(
  '/vehicles/:id/approve',
  sensitiveOpLimiter,
  requirePermission([PERMISSIONS.KYC_VERIFY, PERMISSIONS.VEHICLES_VERIFY]),
  (req, res, next) => adminVerificationController.approveVehicle(req, res, next),
);

// POST /api/v1/admin/verifications/vehicles/:id/reject (Reject vehicle verification with reason)
router.post(
  '/vehicles/:id/reject',
  sensitiveOpLimiter,
  requirePermission([PERMISSIONS.KYC_REJECT, PERMISSIONS.VEHICLES_VERIFY]),
  (req, res, next) => adminVerificationController.rejectVehicle(req, res, next),
);

// ── Document Review & Secure S3 Signed URL (Architecture Section 15) ────────

// GET /api/v1/admin/verifications/documents/:id (Get document metadata)
router.get(
  '/documents/:id',
  requirePermission(PERMISSIONS.KYC_READ),
  (req, res, next) => adminVerificationController.getDocumentDetail(req, res, next),
);

// GET /api/v1/admin/verifications/documents/:id/url (Get short-lived presigned URL)
router.get(
  '/documents/:id/url',
  requirePermission(PERMISSIONS.KYC_READ),
  (req, res, next) => adminVerificationController.getDocumentSignedUrl(req, res, next),
);

// GET /api/v1/admin/verifications/documents/:id/preview (Alias for presigned URL)
router.get(
  '/documents/:id/preview',
  requirePermission(PERMISSIONS.KYC_READ),
  (req, res, next) => adminVerificationController.getDocumentSignedUrl(req, res, next),
);

// GET /api/v1/admin/verifications/documents/:id/download (Alias for presigned URL)
router.get(
  '/documents/:id/download',
  requirePermission(PERMISSIONS.KYC_READ),
  (req, res, next) => adminVerificationController.getDocumentSignedUrl(req, res, next),
);

// POST /api/v1/admin/verifications/documents/:id/approve (Approve individual document)
router.post(
  '/documents/:id/approve',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.KYC_VERIFY),
  (req, res, next) => adminVerificationController.approveDocument(req, res, next),
);

// POST /api/v1/admin/verifications/documents/:id/reject (Reject individual document)
router.post(
  '/documents/:id/reject',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.KYC_REJECT),
  (req, res, next) => adminVerificationController.rejectDocument(req, res, next),
);

// ── Vehicle Image Review & Approval/Rejection (Step 11) ──────────────────────

// GET /api/v1/admin/verifications/vehicle-images/:id (Get image metadata)
router.get(
  '/vehicle-images/:id',
  requirePermission([PERMISSIONS.KYC_READ, PERMISSIONS.VEHICLES_READ]),
  (req, res, next) => adminVerificationController.getVehicleImageDetail(req, res, next),
);

// GET /api/v1/admin/verifications/vehicle-images/:id/url (Get short-lived presigned URL)
router.get(
  '/vehicle-images/:id/url',
  requirePermission([PERMISSIONS.KYC_READ, PERMISSIONS.VEHICLES_READ]),
  (req, res, next) => adminVerificationController.getVehicleImageSignedUrl(req, res, next),
);

// GET /api/v1/admin/verifications/vehicle-images/:id/preview (Alias for presigned URL)
router.get(
  '/vehicle-images/:id/preview',
  requirePermission([PERMISSIONS.KYC_READ, PERMISSIONS.VEHICLES_READ]),
  (req, res, next) => adminVerificationController.getVehicleImageSignedUrl(req, res, next),
);

// POST /api/v1/admin/verifications/vehicle-images/:id/approve (Approve individual vehicle image)
router.post(
  '/vehicle-images/:id/approve',
  sensitiveOpLimiter,
  requirePermission([PERMISSIONS.KYC_VERIFY, PERMISSIONS.VEHICLES_VERIFY]),
  (req, res, next) => adminVerificationController.approveVehicleImage(req, res, next),
);

// POST /api/v1/admin/verifications/vehicle-images/:id/reject (Reject individual vehicle image)
router.post(
  '/vehicle-images/:id/reject',
  sensitiveOpLimiter,
  requirePermission([PERMISSIONS.KYC_REJECT, PERMISSIONS.VEHICLES_VERIFY]),
  (req, res, next) => adminVerificationController.rejectVehicleImage(req, res, next),
);

// POST /api/v1/admin/verifications/:id/approve (Unified approval alias from FRONTEND_API_GUIDE)
router.post(
  '/:id/approve',
  sensitiveOpLimiter,
  requirePermission([PERMISSIONS.KYC_VERIFY, PERMISSIONS.PARTNERS_VERIFY, PERMISSIONS.VEHICLES_VERIFY]),
  (req, res, next) => {
    adminVerificationController.approveDocument(req, res, (err) => {
      if (!err) return;
      adminVerificationController.approveVehicleImage(req, res, (errImg) => {
        if (!errImg) return;
        adminVerificationController.approvePartner(req, res, (err2) => {
          if (!err2) return;
          adminVerificationController.approveVehicle(req, res, next);
        });
      });
    });
  },
);

// POST /api/v1/admin/verifications/:id/reject (Unified rejection alias from FRONTEND_API_GUIDE)
router.post(
  '/:id/reject',
  sensitiveOpLimiter,
  requirePermission([PERMISSIONS.KYC_REJECT, PERMISSIONS.PARTNERS_VERIFY, PERMISSIONS.VEHICLES_VERIFY]),
  (req, res, next) => {
    adminVerificationController.rejectDocument(req, res, (err) => {
      if (!err) return;
      adminVerificationController.rejectVehicleImage(req, res, (errImg) => {
        if (!errImg) return;
        adminVerificationController.rejectPartner(req, res, (err2) => {
          if (!err2) return;
          adminVerificationController.rejectVehicle(req, res, next);
        });
      });
    });
  },
);

module.exports = router;
