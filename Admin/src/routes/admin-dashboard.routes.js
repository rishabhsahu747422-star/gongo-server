'use strict';

const express = require('express');
const adminDashboardController = require('../controllers/admin-dashboard.controller');
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/role');
const { requirePermission } = require('../middlewares/permission');
const { auditMiddleware } = require('../middlewares/audit');
const { ROLES } = require('../constants/roles');
const { PERMISSIONS } = require('../constants/permissions');

const router = express.Router();

// Defense-in-depth: Require authenticated session, authoritative ADMIN role, and audit context
router.use(authenticate);
router.use(requireRole(ROLES.ADMIN));
router.use(auditMiddleware);

// All dashboard endpoints require the dashboard.read permission (or SUPER_ADMIN)
router.use(requirePermission(PERMISSIONS.DASHBOARD_READ));

/**
 * GET /api/v1/admin/dashboard
 * Aggregated cross-domain operational overview + recent administrative activity.
 */
router.get('/', (req, res, next) => {
  adminDashboardController.getOverview(req, res, next);
});

/**
 * GET /api/v1/admin/dashboard/stats
 * Domain-specific status breakdowns and operational statistics.
 */
router.get('/stats', (req, res, next) => {
  adminDashboardController.getStats(req, res, next);
});

/**
 * GET /api/v1/admin/dashboard/revenue
 * Financial volume metrics, platform commissions, payouts, and revenue trend series.
 */
router.get('/revenue', (req, res, next) => {
  adminDashboardController.getRevenue(req, res, next);
});

/**
 * GET /api/v1/admin/dashboard/bookings
 * Booking volume metrics, completion rates, and daily booking trend series.
 */
router.get('/bookings', (req, res, next) => {
  adminDashboardController.getBookings(req, res, next);
});

/**
 * GET /api/v1/admin/dashboard/activity
 * Paginated recent administrative activity.
 */
router.get('/activity', (req, res, next) => {
  adminDashboardController.getActivity(req, res, next);
});

/**
 * GET /api/v1/admin/dashboard/category-distribution
 * Fleet category distribution.
 */
router.get('/category-distribution', (req, res, next) => {
  adminDashboardController.getCategoryDistribution(req, res, next);
});

/**
 * GET /api/v1/admin/dashboard/urgent-alerts
 * Counts of pending verifications requiring admin attention.
 */
router.get('/urgent-alerts', (req, res, next) => {
  adminDashboardController.getUrgentAlerts(req, res, next);
});

module.exports = router;
