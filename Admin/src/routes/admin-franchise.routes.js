'use strict';

const express = require('express');
const franchiseController = require('../controllers/franchise.controller');
const { requirePermission } = require('../middlewares/permission');
const { PERMISSIONS } = require('../constants/permissions');
const { validateStatusUpdate, validateListQuery } = require('../validators/franchise.validator');

const router = express.Router();

/**
 * GET /api/v1/admin/franchise-applications
 * List franchise applications with filtering, search, and pagination.
 */
router.get(
  '/',
  requirePermission(PERMISSIONS.FRANCHISE_READ),
  validateListQuery,
  (req, res, next) => franchiseController.listApplications(req, res, next),
);

/**
 * GET /api/v1/admin/franchise-applications/:id
 * Retrieve application details.
 */
router.get(
  '/:id',
  requirePermission(PERMISSIONS.FRANCHISE_READ),
  (req, res, next) => franchiseController.getApplicationById(req, res, next),
);

/**
 * PATCH /api/v1/admin/franchise-applications/:id/status
 * Update application lifecycle status with audit logging.
 */
router.patch(
  '/:id/status',
  requirePermission(PERMISSIONS.FRANCHISE_UPDATE),
  validateStatusUpdate,
  (req, res, next) => franchiseController.updateStatus(req, res, next),
);

module.exports = router;
