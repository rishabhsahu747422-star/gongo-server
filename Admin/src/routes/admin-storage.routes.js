'use strict';

const express = require('express');
const adminStorageController = require('../controllers/admin-storage.controller');
const { requirePermission } = require('../middlewares/permission');
const { expensiveQueryLimiter, normalQueryLimiter, sensitiveOpLimiter } = require('../middlewares/rateLimiter');
const { PERMISSIONS } = require('../constants/permissions');

const router = express.Router();

const STORAGE_READ_PERMISSIONS = [
  PERMISSIONS.STORAGE_READ,
  PERMISSIONS.STORAGE_DOCUMENTS_READ,
  PERMISSIONS.STORAGE_DOCUMENTS_ACCESS,
  PERMISSIONS.KYC_READ,
];

const STORAGE_ACCESS_PERMISSIONS = [
  PERMISSIONS.STORAGE_READ,
  PERMISSIONS.STORAGE_DOCUMENTS_READ,
  PERMISSIONS.STORAGE_DOCUMENTS_ACCESS,
  PERMISSIONS.KYC_READ,
  PERMISSIONS.KYC_VERIFY,
];

// ── Specific Entity Document Sub-resources (must precede generic /:id) ─────────

/**
 * GET /api/v1/admin/storage/partners/:partnerId/documents
 * Retrieves all documents for a specific partner.
 */
router.get(
  '/partners/:partnerId/documents',
  requirePermission(STORAGE_READ_PERMISSIONS),
  normalQueryLimiter,
  adminStorageController.getPartnerDocuments,
);

/**
 * GET /api/v1/admin/storage/vehicles/:vehicleId/documents
 * Retrieves all documents for a specific vehicle.
 */
router.get(
  '/vehicles/:vehicleId/documents',
  requirePermission(STORAGE_READ_PERMISSIONS),
  normalQueryLimiter,
  adminStorageController.getVehicleDocuments,
);

/**
 * GET /api/v1/admin/storage/customers/:customerId/documents
 * Retrieves all documents for a specific customer.
 */
router.get(
  '/customers/:customerId/documents',
  requirePermission(STORAGE_READ_PERMISSIONS),
  normalQueryLimiter,
  adminStorageController.getCustomerDocuments,
);

// ── Document Sub-actions (must precede /documents/:id) ─────────────────────────

/**
 * GET /api/v1/admin/storage/documents/:id/url
 * Generates temporary signed GET URL for authorized document access.
 */
router.get(
  '/documents/:id/url',
  requirePermission(STORAGE_ACCESS_PERMISSIONS),
  sensitiveOpLimiter,
  adminStorageController.getDocumentSignedUrl,
);

/**
 * GET /api/v1/admin/storage/documents/:id/preview
 * Generates temporary signed GET URL for inline browser preview.
 */
router.get(
  '/documents/:id/preview',
  requirePermission(STORAGE_ACCESS_PERMISSIONS),
  sensitiveOpLimiter,
  adminStorageController.previewDocument,
);

/**
 * GET /api/v1/admin/storage/documents/:id/download
 * Generates temporary signed GET URL for attachment download.
 */
router.get(
  '/documents/:id/download',
  requirePermission(STORAGE_ACCESS_PERMISSIONS),
  sensitiveOpLimiter,
  adminStorageController.downloadDocument,
);

/**
 * POST /api/v1/admin/storage/upload-url
 * Generates a presigned upload URL for direct client storage upload (Supabase/S3).
 */
router.post(
  '/upload-url',
  requirePermission(STORAGE_ACCESS_PERMISSIONS),
  sensitiveOpLimiter,
  adminStorageController.createUploadUrl,
);

/**
 * POST /api/v1/admin/storage/download-url
 * Generates a presigned download URL for direct client storage download (Supabase/S3).
 */
router.post(
  '/download-url',
  requirePermission(STORAGE_ACCESS_PERMISSIONS),
  sensitiveOpLimiter,
  adminStorageController.createDownloadUrl,
);

/**
 * GET /api/v1/admin/storage/documents/:id/history
 * Retrieves chronological administrative audit history for a document.
 */
router.get(
  '/documents/:id/history',
  requirePermission(STORAGE_READ_PERMISSIONS),
  normalQueryLimiter,
  adminStorageController.getDocumentHistory,
);

// ── Generic Document Collection & Detail ──────────────────────────────────────

/**
 * GET /api/v1/admin/storage/documents
 * Lists administrative documents across partner, vehicle, and customer domains.
 */
router.get(
  '/documents',
  requirePermission(STORAGE_READ_PERMISSIONS),
  expensiveQueryLimiter,
  adminStorageController.listDocuments,
);

/**
 * GET /api/v1/admin/storage/documents/:id
 * Retrieves single document detail with safe metadata.
 */
router.get(
  '/documents/:id',
  requirePermission(STORAGE_READ_PERMISSIONS),
  normalQueryLimiter,
  adminStorageController.getDocumentDetail,
);

module.exports = router;
