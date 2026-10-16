'use strict';

const express = require('express');
const adminJobsController = require('../controllers/admin-jobs.controller');
const { requirePermission } = require('../middlewares/permission');
const { expensiveQueryLimiter } = require('../middlewares/rateLimiter');
const { PERMISSIONS } = require('../constants/permissions');

const router = express.Router();
const RELIABILITY_PERMISSIONS = [
  PERMISSIONS.SUPER_ADMIN,
  PERMISSIONS.AUDIT_SECURITY_READ,
  PERMISSIONS.AUDIT_READ,
];

/**
 * GET /api/v1/admin/jobs/overview
 * Operational health and outbox queue metrics.
 */
router.get(
  '/overview',
  requirePermission(RELIABILITY_PERMISSIONS),
  (req, res, next) => adminJobsController.getOverview(req, res, next),
);

/**
 * GET /api/v1/admin/jobs/events
 * Operational outbox event listings with filtering.
 */
router.get(
  '/events',
  requirePermission(RELIABILITY_PERMISSIONS),
  expensiveQueryLimiter,
  (req, res, next) => adminJobsController.listEvents(req, res, next),
);

/**
 * POST /api/v1/admin/jobs/reconcile
 * Trigger an on-demand reconciliation outbox event.
 */
router.post(
  '/reconcile',
  requirePermission(RELIABILITY_PERMISSIONS),
  (req, res, next) => adminJobsController.triggerReconciliation(req, res, next),
);

/**
 * POST /api/v1/admin/jobs/cleanup
 * Trigger an on-demand cleanup outbox event.
 */
router.post(
  '/cleanup',
  requirePermission(RELIABILITY_PERMISSIONS),
  (req, res, next) => adminJobsController.triggerCleanup(req, res, next),
);

module.exports = router;
