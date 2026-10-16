'use strict';

const express = require('express');
const adminReportsController = require('../controllers/admin-reports.controller');
const { requirePermission } = require('../middlewares/permission');
const {
  expensiveQueryLimiter,
  normalQueryLimiter,
  sensitiveOpLimiter,
} = require('../middlewares/rateLimiter');
const { PERMISSIONS } = require('../constants/permissions');

const router = express.Router();

// ── 1. Catalog & Export Operations ─────────────────────────────────────────────

/**
 * GET /api/v1/admin/reports
 * Catalog of supported report definitions.
 */
router.get(
  '/',
  requirePermission([PERMISSIONS.REPORTS_READ]),
  normalQueryLimiter,
  adminReportsController.getReportCatalog,
);

/**
 * POST /api/v1/admin/reports/export
 * Generates controlled CSV export with formula injection defense.
 */
router.post(
  '/export',
  requirePermission([PERMISSIONS.REPORTS_EXPORT]),
  sensitiveOpLimiter,
  adminReportsController.exportReport,
);

/**
 * GET /api/v1/admin/reports/summary
 * Operational summary metrics across platform domains.
 */
router.get(
  '/summary',
  requirePermission([PERMISSIONS.REPORTS_READ, PERMISSIONS.DASHBOARD_READ]),
  expensiveQueryLimiter,
  adminReportsController.getOperationalSummary,
);

// ── 2. Domain-Specific Reports ─────────────────────────────────────────────────

/**
 * GET /api/v1/admin/reports/bookings
 */
router.get(
  '/bookings',
  requirePermission([PERMISSIONS.REPORTS_READ, PERMISSIONS.BOOKINGS_READ]),
  expensiveQueryLimiter,
  adminReportsController.getBookingsReport,
);

/**
 * GET /api/v1/admin/reports/customers
 */
router.get(
  '/customers',
  requirePermission([PERMISSIONS.REPORTS_READ, PERMISSIONS.CUSTOMERS_READ]),
  expensiveQueryLimiter,
  adminReportsController.getCustomersReport,
);

/**
 * GET /api/v1/admin/reports/partners
 */
router.get(
  '/partners',
  requirePermission([PERMISSIONS.REPORTS_READ, PERMISSIONS.PARTNERS_READ]),
  expensiveQueryLimiter,
  adminReportsController.getPartnersReport,
);

/**
 * GET /api/v1/admin/reports/vehicles
 */
router.get(
  '/vehicles',
  requirePermission([PERMISSIONS.REPORTS_READ, PERMISSIONS.VEHICLES_READ]),
  expensiveQueryLimiter,
  adminReportsController.getVehiclesReport,
);

/**
 * GET /api/v1/admin/reports/payments
 */
router.get(
  '/payments',
  requirePermission([PERMISSIONS.REPORTS_READ, PERMISSIONS.PAYMENTS_READ]),
  expensiveQueryLimiter,
  adminReportsController.getPaymentsReport,
);

/**
 * GET /api/v1/admin/reports/refunds
 */
router.get(
  '/refunds',
  requirePermission([PERMISSIONS.REPORTS_READ, PERMISSIONS.REFUNDS_READ]),
  expensiveQueryLimiter,
  adminReportsController.getRefundsReport,
);

/**
 * GET /api/v1/admin/reports/commissions
 * Internal company data - strictly requires commissions.read or SUPER_ADMIN
 */
router.get(
  '/commissions',
  requirePermission([PERMISSIONS.COMMISSIONS_READ]),
  expensiveQueryLimiter,
  adminReportsController.getCommissionsReport,
);

/**
 * GET /api/v1/admin/reports/wallets
 */
router.get(
  '/wallets',
  requirePermission([PERMISSIONS.REPORTS_READ, PERMISSIONS.WALLETS_READ]),
  expensiveQueryLimiter,
  adminReportsController.getWalletsReport,
);

/**
 * GET /api/v1/admin/reports/payouts
 */
router.get(
  '/payouts',
  requirePermission([PERMISSIONS.REPORTS_READ, PERMISSIONS.PAYOUTS_READ]),
  expensiveQueryLimiter,
  adminReportsController.getPayoutsReport,
);

/**
 * GET /api/v1/admin/reports/kyc
 */
router.get(
  '/kyc',
  requirePermission([PERMISSIONS.REPORTS_READ, PERMISSIONS.KYC_READ]),
  expensiveQueryLimiter,
  adminReportsController.getKycReport,
);

/**
 * GET /api/v1/admin/reports/support
 */
router.get(
  '/support',
  requirePermission([PERMISSIONS.REPORTS_READ, PERMISSIONS.SUPPORT_READ]),
  expensiveQueryLimiter,
  adminReportsController.getSupportReport,
);

/**
 * GET /api/v1/admin/reports/disputes
 */
router.get(
  '/disputes',
  requirePermission([
    PERMISSIONS.REPORTS_READ,
    PERMISSIONS.DISPUTES_READ,
    PERMISSIONS.DAMAGES_READ,
  ]),
  expensiveQueryLimiter,
  adminReportsController.getDisputesReport,
);

/**
 * GET /api/v1/admin/reports/notifications
 */
router.get(
  '/notifications',
  requirePermission([PERMISSIONS.REPORTS_READ, PERMISSIONS.NOTIFICATIONS_READ]),
  expensiveQueryLimiter,
  adminReportsController.getNotificationsReport,
);

module.exports = router;
