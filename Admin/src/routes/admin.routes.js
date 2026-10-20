'use strict';

const express = require('express');
const adminAuthRoutes = require('./admin-auth.routes');
const adminPermissionRoutes = require('./admin-permission.routes');
const adminProfileRoutes = require('./admin-profile.routes');
const adminDashboardRoutes = require('./admin-dashboard.routes');
const adminPartnerRoutes = require('./admin-partner.routes');
const adminCustomerRoutes = require('./admin-customer.routes');
const adminVehicleRoutes = require('./admin-vehicle.routes');
const adminBookingRoutes = require('./admin-booking.routes');
const adminVerificationRoutes = require('./admin-verification.routes');
const adminVerificationController = require('../controllers/admin-verification.controller');
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/role');
const { requirePermission } = require('../middlewares/permission');
const { auditMiddleware } = require('../middlewares/audit');
const { sensitiveOpLimiter } = require('../middlewares/rateLimiter');
const { ROLES } = require('../constants/roles');
const { PERMISSIONS } = require('../constants/permissions');
const { sendSuccess } = require('../utils/response');

const router = express.Router();

// ── Admin Authentication & Session Lifecycle ────────────────────────────────
// Mounts /api/v1/admin/auth/* endpoints (login, me, logout, logout-all, refresh)
router.use('/auth', adminAuthRoutes);

// ── Global Admin Route Guards ───────────────────────────────────────────────
// Applied to all subsequent privileged administrative routes:
// 1. Authenticate Admin session or Supabase token
// 2. Enforce authoritative database ADMIN role
// 3. Attach audit context middleware
router.use(authenticate);
router.use(requireRole(ROLES.ADMIN));
router.use(auditMiddleware);

/**
 * Phase 0 Admin Root Verification Probe
 */
router.get('/', (req, res) => {
  sendSuccess(res, {
    message: 'GONGO Admin Backend API gateway initialized',
    actor: {
      id: req.user.id,
      role: req.user.role,
    },
  });
});

// ── Permission Management (Phase 4 — RBAC & Granular Permissions) ───────────
// Inherits authenticate + requireRole(ADMIN) + auditMiddleware from above.
router.use('/permissions', adminPermissionRoutes);

// ── Profile & Account Security (Phase 5) ────────────────────────────────────
// Inherits authenticate + requireRole(ADMIN) + auditMiddleware from above.
router.use('/profile', adminProfileRoutes);

// ── Dashboard & Platform Metrics (Phase 6) ──────────────────────────────────
// Inherits authenticate + requireRole(ADMIN) + auditMiddleware from above.
router.use('/dashboard', adminDashboardRoutes);

// ── Partner Management (Phase 7) ───────────────────────────────────────────
// Inherits authenticate + requireRole(ADMIN) + auditMiddleware from above.
router.use('/partners', adminPartnerRoutes);

// ── Customer Management (Phase 8) ───────────────────────────────────────────
// Inherits authenticate + requireRole(ADMIN) + auditMiddleware from above.
router.use('/customers', adminCustomerRoutes);

// ── Vehicle & Fleet Management (Phase 9) ────────────────────────────────────
// Inherits authenticate + requireRole(ADMIN) + auditMiddleware from above.
router.use('/vehicles', adminVehicleRoutes);

// ── Booking Management (Phase 10) ───────────────────────────────────────────
// Inherits authenticate + requireRole(ADMIN) + auditMiddleware from above.
router.use('/bookings', adminBookingRoutes);

// ── KYC & Document Verification (Phase 11) ──────────────────────────────────
// Inherits authenticate + requireRole(ADMIN) + auditMiddleware from above.
router.use('/verifications', adminVerificationRoutes);
router.use('/verification', adminVerificationRoutes);

// ── Vehicle Documents Direct Alias Routes ───────────────────────────────────
const vehicleDocumentRoutes = express.Router();
vehicleDocumentRoutes.get(
  '/:id',
  requirePermission(PERMISSIONS.KYC_READ),
  (req, res, next) => adminVerificationController.getDocumentDetail(req, res, next),
);
vehicleDocumentRoutes.get(
  '/:id/url',
  requirePermission(PERMISSIONS.KYC_READ),
  (req, res, next) => adminVerificationController.getDocumentSignedUrl(req, res, next),
);
vehicleDocumentRoutes.post(
  '/:id/approve',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.KYC_VERIFY),
  (req, res, next) => adminVerificationController.approveDocument(req, res, next),
);
vehicleDocumentRoutes.post(
  '/:id/reject',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.KYC_REJECT),
  (req, res, next) => adminVerificationController.rejectDocument(req, res, next),
);
router.use('/vehicle-documents', vehicleDocumentRoutes);

// ── Payments & Financial Operations (Phase 12) ──────────────────────────────
// Inherits authenticate + requireRole(ADMIN) + auditMiddleware from above.
const {
  paymentRouter,
  refundRouter,
  commissionRouter,
  commissionRulesRouter,
  commissionTransactionsRouter,
  financeRouter,
} = require('./admin-payment.routes');

router.use('/payments', paymentRouter);
router.use('/refunds', refundRouter);
router.use('/commissions', commissionRouter);
router.use('/commission-rules', commissionRulesRouter);
router.use('/commission-transactions', commissionTransactionsRouter);
router.use('/finance', financeRouter);

// ── Wallet & Payout Management (Phase 13) ───────────────────────────────────
// Inherits authenticate + requireRole(ADMIN) + auditMiddleware from above.
const {
  walletRouter,
  payoutRouter,
  bankAccountRouter,
  financialsRouter,
} = require('./admin-wallet.routes');

router.use('/wallets', walletRouter);
router.use('/payouts', payoutRouter);
router.use('/payout-requests', payoutRouter);
router.use('/bank-accounts', bankAccountRouter);
router.use('/financials', financialsRouter);

// ── Damage & Dispute Management (Phase 14) ───────────────────────────────────
// Inherits authenticate + requireRole(ADMIN) + auditMiddleware from above.
const {
  damageRouter,
  disputeRouter,
} = require('./admin-damage-dispute.routes');

router.use('/damages', damageRouter);
router.use('/disputes', disputeRouter);

// ── Support & Ticket Management (Phase 15) ───────────────────────────────────
// Inherits authenticate + requireRole(ADMIN) + auditMiddleware from above.
const { supportRouter } = require('./admin-support.routes');

router.use('/support', supportRouter);

// ── Notifications & Communication (Phase 16) ─────────────────────────────────
// Inherits authenticate + requireRole(ADMIN) + auditMiddleware from above.
const adminNotificationRoutes = require('./admin-notification.routes');

router.use('/notifications', adminNotificationRoutes);
router.use('/notification-templates', adminNotificationRoutes);

// ── Audit & Security Monitoring (Phase 17) ──────────────────────────────────
// Inherits authenticate + requireRole(ADMIN) + auditMiddleware from above.
const { auditRouter, securityRouter } = require('./admin-audit.routes');

router.use('/audit', auditRouter);
router.use('/audit-logs', auditRouter);
router.use('/security', securityRouter);

// ── Storage & Document Operations (Phase 18) ─────────────────────────────────
// Inherits authenticate + requireRole(ADMIN) + auditMiddleware from above.
const adminStorageRoutes = require('./admin-storage.routes');

router.use('/storage', adminStorageRoutes);

// ── Reports & Data Export (Phase 19) ──────────────────────────────────────────
// Inherits authenticate + requireRole(ADMIN) + auditMiddleware from above.
const adminReportsRoutes = require('./admin-reports.routes');

router.use('/reports', adminReportsRoutes);

// ── Reliability & Background Jobs (Phase 20) ─────────────────────────────────
// Inherits authenticate + requireRole(ADMIN) + auditMiddleware from above.
const adminJobsRoutes = require('./admin-jobs.routes');

router.use('/jobs', adminJobsRoutes);

// ── Shop Management ──────────────────────────────────────────────────────────
const adminShopRoutes = require('./admin-shop.routes');

router.use('/shops', adminShopRoutes);

// ── Coupons Management (Section 20) ──────────────────────────────────────────
const adminCouponRoutes = require('./admin-coupon.routes');

router.use('/coupons', adminCouponRoutes);

// ── Offers & Discounts (Section 21) ──────────────────────────────────────────
const adminOfferRoutes = require('./admin-offer.routes');

router.use('/offers', adminOfferRoutes);

// ── Home Banner Management ──────────────────────────────────────────────────
const adminBannerRoutes = require('./admin-banner.routes');

router.use('/banners', adminBannerRoutes);

// ── Rental Agreements (Section 24) ───────────────────────────────────────────
const adminAgreementRoutes = require('./admin-agreement.routes');

router.use('/agreements', adminAgreementRoutes);

// ── Customer Reviews & Moderation (Section 19) ──────────────────────────────
const adminReviewRoutes = require('./admin-review.routes');

router.use('/reviews', adminReviewRoutes);
router.use('/review-reports', adminReviewRoutes);

// ── Internal Admin Users Management ─────────────────────────────────────────
const adminUserRoutes = require('./admin-user.routes');

router.use('/users', adminUserRoutes);

// ── System Settings & Configuration ─────────────────────────────────────────
const adminSettingsRoutes = require('./admin-settings.routes');

router.use('/settings', adminSettingsRoutes);

// ── Platform Fee Settings ───────────────────────────────────────────────────
const adminPlatformFeeRoutes = require('./admin-platform-fee.routes');

router.use('/platform-fee', adminPlatformFeeRoutes);
router.use('/platform-charge', adminPlatformFeeRoutes);
router.use('/platform-charges', adminPlatformFeeRoutes);

// ── Cancellation Refund Rules ──────────────────────────────────────────────
const adminCancellationRulesRoutes = require('./admin-cancellation-rules.routes');

router.use('/cancellation-rules', adminCancellationRulesRoutes);
router.use('/cancellation-rule', adminCancellationRulesRoutes);
router.use('/cancellation-tiers', adminCancellationRulesRoutes);

// ── Franchise Applications Management ───────────────────────────────────────
const adminFranchiseRoutes = require('./admin-franchise.routes');

router.use('/franchise-applications', adminFranchiseRoutes);
router.use('/franchise', adminFranchiseRoutes);

// ── Payout & Settlements Alias ──────────────────────────────────────────────
router.use('/settlements', payoutRouter);

module.exports = router;
