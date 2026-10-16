'use strict';

const express = require('express');
const adminAuditController = require('../controllers/admin-audit.controller');
const { requirePermission } = require('../middlewares/permission');
const { expensiveQueryLimiter } = require('../middlewares/rateLimiter');
const { PERMISSIONS } = require('../constants/permissions');

const auditRouter = express.Router();
const securityRouter = express.Router();

const AUDIT_OR_SECURITY = [PERMISSIONS.AUDIT_READ, PERMISSIONS.AUDIT_SECURITY_READ];

// ── Audit Log Endpoints ───────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/audit
 * GET /api/v1/admin/audit-logs
 * Lists administrative audit actions with filtering, search, and pagination.
 */
auditRouter.get(
  '/',
  requirePermission(AUDIT_OR_SECURITY),
  expensiveQueryLimiter,
  adminAuditController.listAudit,
);

/**
 * GET /api/v1/admin/audit/actions
 * Returns catalog of distinct action names, target resources, and security categories.
 */
auditRouter.get(
  '/actions',
  requirePermission(AUDIT_OR_SECURITY),
  adminAuditController.getActionsCatalog,
);

/**
 * GET /api/v1/admin/audit/security
 * Returns security-classified audit events.
 */
auditRouter.get(
  '/security',
  requirePermission(AUDIT_OR_SECURITY),
  expensiveQueryLimiter,
  adminAuditController.getSecurityEvents,
);

/**
 * GET /api/v1/admin/audit/admin/:adminId
 * Returns audit trail for a specific administrator.
 */
auditRouter.get(
  '/admin/:adminId',
  requirePermission(AUDIT_OR_SECURITY),
  expensiveQueryLimiter,
  adminAuditController.getAuditByAdmin,
);

/**
 * GET /api/v1/admin/audit/resource/:resourceType/:resourceId
 * Returns chronological audit trail for a specific resource entity.
 */
auditRouter.get(
  '/resource/:resourceType/:resourceId',
  requirePermission(AUDIT_OR_SECURITY),
  expensiveQueryLimiter,
  adminAuditController.getAuditByResource,
);

/**
 * GET /api/v1/admin/audit/:id
 * GET /api/v1/admin/audit-logs/:id
 * Retrieves single audit record detail by UUID.
 */
auditRouter.get(
  '/:id',
  requirePermission(AUDIT_OR_SECURITY),
  adminAuditController.getAuditDetail,
);

// ── Security Monitoring Endpoints ─────────────────────────────────────────────

/**
 * GET /api/v1/admin/security/events
 * Returns security-classified audit events.
 */
securityRouter.get(
  '/events',
  requirePermission(AUDIT_OR_SECURITY),
  expensiveQueryLimiter,
  adminAuditController.getSecurityEvents,
);

/**
 * GET /api/v1/admin/security/summary
 * Returns operational security summary metrics across a bounded time window.
 */
securityRouter.get(
  '/summary',
  requirePermission(AUDIT_OR_SECURITY),
  expensiveQueryLimiter,
  adminAuditController.getSecuritySummary,
);

module.exports = {
  auditRouter,
  securityRouter,
};
