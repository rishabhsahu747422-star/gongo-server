'use strict';

const express = require('express');
const adminPaymentController = require('../controllers/admin-payment.controller');
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/role');
const { requirePermission } = require('../middlewares/permission');
const { auditMiddleware } = require('../middlewares/audit');
const { sensitiveOpLimiter } = require('../middlewares/rateLimiter');
const { ROLES } = require('../constants/roles');
const { PERMISSIONS } = require('../constants/permissions');

// ══════════════════════════════════════════════════════════════════════════════
// 1. PAYMENT ROUTES (Architecture Section 17)
// ══════════════════════════════════════════════════════════════════════════════

const paymentRouter = express.Router();
paymentRouter.use(authenticate);
paymentRouter.use(requireRole(ROLES.ADMIN));
paymentRouter.use(auditMiddleware);

// GET /api/v1/admin/payments/summary (Financial overview for payments)
paymentRouter.get(
  '/summary',
  requirePermission([PERMISSIONS.PAYMENTS_READ, PERMISSIONS.COMMISSIONS_READ]),
  (req, res, next) => adminPaymentController.getFinancialSummary(req, res, next),
);

// GET /api/v1/admin/payments (List payments with filters & pagination)
paymentRouter.get(
  '/',
  requirePermission(PERMISSIONS.PAYMENTS_READ),
  (req, res, next) => adminPaymentController.listPayments(req, res, next),
);

// GET /api/v1/admin/payments/:id/booking (Payment's associated booking)
paymentRouter.get(
  '/:id/booking',
  requirePermission(PERMISSIONS.PAYMENTS_READ),
  (req, res, next) => adminPaymentController.getPaymentBooking(req, res, next),
);

// GET /api/v1/admin/payments/:id/customer (Payment's customer details)
paymentRouter.get(
  '/:id/customer',
  requirePermission(PERMISSIONS.PAYMENTS_READ),
  (req, res, next) => adminPaymentController.getPaymentCustomer(req, res, next),
);

// GET /api/v1/admin/payments/:id/partner (Payment's partner details)
paymentRouter.get(
  '/:id/partner',
  requirePermission(PERMISSIONS.PAYMENTS_READ),
  (req, res, next) => adminPaymentController.getPaymentPartner(req, res, next),
);

// GET /api/v1/admin/payments/:id/timeline (Payment lifecycle timeline)
paymentRouter.get(
  '/:id/timeline',
  requirePermission(PERMISSIONS.PAYMENTS_READ),
  (req, res, next) => adminPaymentController.getPaymentTimeline(req, res, next),
);

// GET /api/v1/admin/payments/:id/attempts (Payment retry history)
paymentRouter.get(
  '/:id/attempts',
  requirePermission(PERMISSIONS.PAYMENTS_READ),
  (req, res, next) => adminPaymentController.getPaymentAttempts(req, res, next),
);

// GET /api/v1/admin/payments/:id/transactions (Payment transactions & refunds)
paymentRouter.get(
  '/:id/transactions',
  requirePermission(PERMISSIONS.PAYMENTS_READ),
  (req, res, next) => adminPaymentController.getPaymentTransactions(req, res, next),
);

// GET /api/v1/admin/payments/:id/webhooks (Payment webhook events)
paymentRouter.get(
  '/:id/webhooks',
  requirePermission(PERMISSIONS.PAYMENTS_READ),
  (req, res, next) => adminPaymentController.getPaymentWebhooks(req, res, next),
);

// POST /api/v1/admin/payments/:id/reconcile (Reconcile status with Cashfree)
paymentRouter.post(
  '/:id/reconcile',
  sensitiveOpLimiter,
  // Reconciliation mutates payment state, so read access alone is not sufficient
  requirePermission(PERMISSIONS.PAYMENTS_REFUND),
  (req, res, next) => adminPaymentController.reconcilePayment(req, res, next),
);

// POST /api/v1/admin/payments/:id/refund (Initiate payment refund)
paymentRouter.post(
  '/:id/refund',
  sensitiveOpLimiter,
  requirePermission([PERMISSIONS.PAYMENTS_REFUND, PERMISSIONS.REFUNDS_APPROVE]),
  (req, res, next) => adminPaymentController.createPaymentRefund(req, res, next),
);

// GET /api/v1/admin/payments/:id (Payment detail)
paymentRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.PAYMENTS_READ),
  (req, res, next) => adminPaymentController.getPaymentById(req, res, next),
);

// ══════════════════════════════════════════════════════════════════════════════
// 2. REFUND ROUTES (Architecture Section 18)
// ══════════════════════════════════════════════════════════════════════════════

const refundRouter = express.Router();
refundRouter.use(authenticate);
refundRouter.use(requireRole(ROLES.ADMIN));
refundRouter.use(auditMiddleware);

// GET /api/v1/admin/refunds (List refunds with filters & pagination)
refundRouter.get(
  '/',
  requirePermission([PERMISSIONS.REFUNDS_READ, PERMISSIONS.PAYMENTS_READ]),
  (req, res, next) => adminPaymentController.listRefunds(req, res, next),
);

// POST /api/v1/admin/refunds/:id/approve (Approve refund & execute on gateway)
refundRouter.post(
  '/:id/approve',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.REFUNDS_APPROVE),
  (req, res, next) => adminPaymentController.approveRefund(req, res, next),
);

// POST /api/v1/admin/refunds/:id/reject (Reject refund with mandatory reason)
refundRouter.post(
  '/:id/reject',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.REFUNDS_APPROVE),
  (req, res, next) => adminPaymentController.rejectRefund(req, res, next),
);

// POST /api/v1/admin/refunds/:id/process (Process refund)
refundRouter.post(
  '/:id/process',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.REFUNDS_APPROVE),
  (req, res, next) => adminPaymentController.processRefund(req, res, next),
);

// GET /api/v1/admin/refunds/:id (Refund detail)
refundRouter.get(
  '/:id',
  requirePermission([PERMISSIONS.REFUNDS_READ, PERMISSIONS.PAYMENTS_READ]),
  (req, res, next) => adminPaymentController.getRefundById(req, res, next),
);

// ══════════════════════════════════════════════════════════════════════════════
// 3. COMMISSION ROUTES (Architecture Section 19)
// ══════════════════════════════════════════════════════════════════════════════

const commissionRouter = express.Router();
commissionRouter.use(authenticate);
commissionRouter.use(requireRole(ROLES.ADMIN));
commissionRouter.use(auditMiddleware);

// GET /api/v1/admin/commissions/rules/targets (List available targets: categories, partners, vehicles)
commissionRouter.get(
  '/rules/targets',
  requirePermission(PERMISSIONS.COMMISSIONS_READ),
  (req, res, next) => adminPaymentController.getCommissionRuleTargets(req, res, next),
);

// GET /api/v1/admin/commissions/rules (List commission rules)
commissionRouter.get(
  '/rules',
  requirePermission(PERMISSIONS.COMMISSIONS_READ),
  (req, res, next) => adminPaymentController.listCommissionRules(req, res, next),
);

// POST /api/v1/admin/commissions/rules (Create commission rule)
commissionRouter.post(
  '/rules',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.COMMISSIONS_UPDATE),
  (req, res, next) => adminPaymentController.createCommissionRule(req, res, next),
);

// GET /api/v1/admin/commissions/rules/:id (Get commission rule)
commissionRouter.get(
  '/rules/:id',
  requirePermission(PERMISSIONS.COMMISSIONS_READ),
  (req, res, next) => adminPaymentController.getCommissionRuleById(req, res, next),
);

// PATCH /api/v1/admin/commissions/rules/:id (Update commission rule)
commissionRouter.patch(
  '/rules/:id',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.COMMISSIONS_UPDATE),
  (req, res, next) => adminPaymentController.updateCommissionRule(req, res, next),
);

// DELETE /api/v1/admin/commissions/rules/:id (Delete commission rule)
commissionRouter.delete(
  '/rules/:id',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.COMMISSIONS_UPDATE),
  (req, res, next) => adminPaymentController.deleteCommissionRule(req, res, next),
);

// GET /api/v1/admin/commissions/transactions (List historical commission transactions)
commissionRouter.get(
  '/transactions',
  requirePermission(PERMISSIONS.COMMISSIONS_READ),
  (req, res, next) => adminPaymentController.listCommissionTransactions(req, res, next),
);

// GET /api/v1/admin/commissions/transactions/:id (Get commission transaction)
commissionRouter.get(
  '/transactions/:id',
  requirePermission(PERMISSIONS.COMMISSIONS_READ),
  (req, res, next) => adminPaymentController.getCommissionTransactionById(req, res, next),
);

// GET /api/v1/admin/commissions (List commissions)
commissionRouter.get(
  '/',
  requirePermission(PERMISSIONS.COMMISSIONS_READ),
  (req, res, next) => adminPaymentController.listCommissions(req, res, next),
);

// GET /api/v1/admin/commissions/:id (Commission detail)
commissionRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.COMMISSIONS_READ),
  (req, res, next) => adminPaymentController.getCommissionById(req, res, next),
);

// ══════════════════════════════════════════════════════════════════════════════
// 4. DEDICATED COMMISSION RULES & TRANSACTIONS ROUTERS (Section 16)
// ══════════════════════════════════════════════════════════════════════════════

const commissionRulesRouter = express.Router();
commissionRulesRouter.use(authenticate);
commissionRulesRouter.use(requireRole(ROLES.ADMIN));
commissionRulesRouter.use(auditMiddleware);

commissionRulesRouter.get(
  '/targets',
  requirePermission(PERMISSIONS.COMMISSIONS_READ),
  (req, res, next) => adminPaymentController.getCommissionRuleTargets(req, res, next),
);

commissionRulesRouter.get(
  '/',
  requirePermission(PERMISSIONS.COMMISSIONS_READ),
  (req, res, next) => adminPaymentController.listCommissionRules(req, res, next),
);
commissionRulesRouter.post(
  '/',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.COMMISSIONS_UPDATE),
  (req, res, next) => adminPaymentController.createCommissionRule(req, res, next),
);
commissionRulesRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.COMMISSIONS_READ),
  (req, res, next) => adminPaymentController.getCommissionRuleById(req, res, next),
);
commissionRulesRouter.patch(
  '/:id',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.COMMISSIONS_UPDATE),
  (req, res, next) => adminPaymentController.updateCommissionRule(req, res, next),
);
commissionRulesRouter.delete(
  '/:id',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.COMMISSIONS_UPDATE),
  (req, res, next) => adminPaymentController.deleteCommissionRule(req, res, next),
);

const commissionTransactionsRouter = express.Router();
commissionTransactionsRouter.use(authenticate);
commissionTransactionsRouter.use(requireRole(ROLES.ADMIN));
commissionTransactionsRouter.use(auditMiddleware);

commissionTransactionsRouter.get(
  '/',
  requirePermission(PERMISSIONS.COMMISSIONS_READ),
  (req, res, next) => adminPaymentController.listCommissionTransactions(req, res, next),
);
commissionTransactionsRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.COMMISSIONS_READ),
  (req, res, next) => adminPaymentController.getCommissionTransactionById(req, res, next),
);

// ══════════════════════════════════════════════════════════════════════════════
// 5. FINANCE OVERVIEW ROUTES
// ══════════════════════════════════════════════════════════════════════════════

const financeRouter = express.Router();
financeRouter.use(authenticate);
financeRouter.use(requireRole(ROLES.ADMIN));
financeRouter.use(auditMiddleware);

// GET /api/v1/admin/finance/summary (Consolidated platform financial summary)
financeRouter.get(
  '/summary',
  requirePermission([PERMISSIONS.PAYMENTS_READ, PERMISSIONS.COMMISSIONS_READ]),
  (req, res, next) => adminPaymentController.getFinancialSummary(req, res, next),
);

module.exports = {
  paymentRouter,
  refundRouter,
  commissionRouter,
  commissionRulesRouter,
  commissionTransactionsRouter,
  financeRouter,
};
