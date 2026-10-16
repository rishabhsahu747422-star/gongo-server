'use strict';

const express = require('express');
const adminCustomerController = require('../controllers/admin-customer.controller');
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

// GET /api/v1/admin/customers (List customers with search/filter/pagination)
router.get(
  '/',
  requirePermission(PERMISSIONS.CUSTOMERS_READ),
  (req, res, next) => adminCustomerController.listCustomers(req, res, next),
);

// GET /api/v1/admin/customers/:id (Customer detail view + operational summaries)
router.get(
  '/:id',
  requirePermission(PERMISSIONS.CUSTOMERS_READ),
  (req, res, next) => adminCustomerController.getCustomerDetail(req, res, next),
);

// GET /api/v1/admin/customers/:id/bookings (Customer bookings history with pagination)
router.get(
  '/:id/bookings',
  requirePermission(PERMISSIONS.CUSTOMERS_READ),
  (req, res, next) => adminCustomerController.getCustomerBookings(req, res, next),
);

// GET /api/v1/admin/customers/:id/payments (Customer payments history with pagination)
router.get(
  '/:id/payments',
  requirePermission(PERMISSIONS.CUSTOMERS_READ),
  (req, res, next) => adminCustomerController.getCustomerPayments(req, res, next),
);

// GET /api/v1/admin/customers/:id/documents (Customer verification documents metadata)
router.get(
  '/:id/documents',
  requirePermission(PERMISSIONS.CUSTOMERS_READ),
  (req, res, next) => adminCustomerController.getCustomerDocuments(req, res, next),
);

// GET /api/v1/admin/customers/:id/verifications (Identity verifications from customer_identity_verifications)
router.get(
  '/:id/verifications',
  requirePermission(PERMISSIONS.CUSTOMERS_READ),
  (req, res, next) => adminCustomerController.getCustomerVerifications(req, res, next),
);

// GET /api/v1/admin/customers/:id/support-tickets (Support tickets from support_tickets)
router.get(
  '/:id/support-tickets',
  requirePermission(PERMISSIONS.CUSTOMERS_READ),
  (req, res, next) => adminCustomerController.getCustomerSupportTickets(req, res, next),
);

// GET /api/v1/admin/customers/:id/addresses (Customer saved addresses)
router.get(
  '/:id/addresses',
  requirePermission(PERMISSIONS.CUSTOMERS_READ),
  (req, res, next) => adminCustomerController.getCustomerAddresses(req, res, next),
);

// GET /api/v1/admin/customers/:id/activity (Customer administrative audit activity history)
router.get(
  '/:id/activity',
  requirePermission(PERMISSIONS.CUSTOMERS_READ),
  (req, res, next) => adminCustomerController.getCustomerActivity(req, res, next),
);

// ── Mutation Operations ─────────────────────────────────────────────────────

// PATCH /api/v1/admin/customers/:id/status (Update customer active / inactive status)
router.patch(
  '/:id/status',
  sensitiveOpLimiter,
  requirePermission([PERMISSIONS.CUSTOMERS_UPDATE, PERMISSIONS.CUSTOMERS_SUSPEND]),
  (req, res, next) => adminCustomerController.updateCustomerStatus(req, res, next),
);

module.exports = router;
