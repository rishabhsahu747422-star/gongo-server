'use strict';

const express = require('express');
const adminBookingController = require('../controllers/admin-booking.controller');
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/role');
const { requirePermission } = require('../middlewares/permission');
const { auditMiddleware } = require('../middlewares/audit');
const { sensitiveOpLimiter } = require('../middlewares/rateLimiter');
const { ROLES } = require('../constants/roles');
const { PERMISSIONS } = require('../constants/permissions');

const router = express.Router();

// Defense-in-depth: Require authenticated session, authoritative ADMIN or SUPPORT_EXECUTIVE role, and audit context
router.use(authenticate);
router.use(requireRole([ROLES.ADMIN, ROLES.SUPPORT_EXECUTIVE]));
router.use(auditMiddleware);

// ── Read Operations ─────────────────────────────────────────────────────────

// GET /api/v1/admin/bookings (List bookings with search/filter/pagination)
router.get(
  '/',
  requirePermission(PERMISSIONS.BOOKINGS_READ),
  (req, res, next) => adminBookingController.listBookings(req, res, next),
);

// GET /api/v1/admin/bookings/:id (Booking detail view)
router.get(
  '/:id',
  requirePermission(PERMISSIONS.BOOKINGS_READ),
  (req, res, next) => adminBookingController.getBookingDetail(req, res, next),
);

// GET /api/v1/admin/bookings/:id/status-history
router.get(
  '/:id/status-history',
  requirePermission(PERMISSIONS.BOOKINGS_READ),
  (req, res, next) => adminBookingController.getBookingStatusHistory(req, res, next),
);

// GET /api/v1/admin/bookings/:id/customer
router.get(
  '/:id/customer',
  requirePermission(PERMISSIONS.BOOKINGS_READ),
  (req, res, next) => adminBookingController.getBookingCustomer(req, res, next),
);

// GET /api/v1/admin/bookings/:id/pickup
router.get(
  '/:id/pickup',
  requirePermission(PERMISSIONS.BOOKINGS_READ),
  (req, res, next) => adminBookingController.getBookingPickup(req, res, next),
);

// GET /api/v1/admin/bookings/:id/return
router.get(
  '/:id/return',
  requirePermission(PERMISSIONS.BOOKINGS_READ),
  (req, res, next) => adminBookingController.getBookingReturn(req, res, next),
);

// GET /api/v1/admin/bookings/:id/agreement
router.get(
  '/:id/agreement',
  requirePermission(PERMISSIONS.BOOKINGS_READ),
  (req, res, next) => adminBookingController.getBookingAgreement(req, res, next),
);

// GET /api/v1/admin/bookings/:id/timeline (Deterministic chronological timeline)
router.get(
  '/:id/timeline',
  requirePermission(PERMISSIONS.BOOKINGS_READ),
  (req, res, next) => adminBookingController.getBookingTimeline(req, res, next),
);

// GET /api/v1/admin/bookings/:id/payment (Associated payments)
router.get(
  '/:id/payment',
  requirePermission(PERMISSIONS.BOOKINGS_READ),
  (req, res, next) => adminBookingController.getBookingPayments(req, res, next),
);

// GET /api/v1/admin/bookings/:id/payments (Alias for associated payments)
router.get(
  '/:id/payments',
  requirePermission(PERMISSIONS.BOOKINGS_READ),
  (req, res, next) => adminBookingController.getBookingPayments(req, res, next),
);

// GET /api/v1/admin/bookings/:id/commission (Confidential company commission record)
router.get(
  '/:id/commission',
  requirePermission(PERMISSIONS.BOOKINGS_READ),
  (req, res, next) => adminBookingController.getBookingCommission(req, res, next),
);

// GET /api/v1/admin/bookings/:id/settlement (Partner earnings and settlement status)
router.get(
  '/:id/settlement',
  requirePermission(PERMISSIONS.BOOKINGS_READ),
  (req, res, next) => adminBookingController.getBookingSettlement(req, res, next),
);

// GET /api/v1/admin/bookings/:id/tracking (Pickup/return verifications & damage reports)
router.get(
  '/:id/tracking',
  requirePermission(PERMISSIONS.BOOKINGS_READ),
  (req, res, next) => adminBookingController.getBookingTracking(req, res, next),
);

// ── Mutation Operations (Status & Cancellation) ──────────────────────────────

// PATCH /api/v1/admin/bookings/:id/status (Update booking status with state machine validation)
router.patch(
  '/:id/status',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.BOOKINGS_UPDATE),
  (req, res, next) => adminBookingController.updateBookingStatus(req, res, next),
);

// POST /api/v1/admin/bookings/:id/cancel (Cancel booking atomically with reason)
router.post(
  '/:id/cancel',
  sensitiveOpLimiter,
  requirePermission([PERMISSIONS.BOOKINGS_CANCEL, PERMISSIONS.BOOKINGS_UPDATE]),
  (req, res, next) => adminBookingController.cancelBooking(req, res, next),
);

module.exports = router;
