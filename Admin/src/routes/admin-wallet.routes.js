'use strict';

const express = require('express');
const adminWalletController = require('../controllers/admin-wallet.controller');
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/role');
const { requirePermission } = require('../middlewares/permission');
const { auditMiddleware } = require('../middlewares/audit');
const { sensitiveOpLimiter } = require('../middlewares/rateLimiter');
const { ROLES } = require('../constants/roles');
const { PERMISSIONS } = require('../constants/permissions');

// ══════════════════════════════════════════════════════════════════════════════
// 1. WALLET ROUTER (/api/v1/admin/wallets)
// ══════════════════════════════════════════════════════════════════════════════
const walletRouter = express.Router();
walletRouter.use(authenticate);
walletRouter.use(requireRole(ROLES.ADMIN));
walletRouter.use(auditMiddleware);

walletRouter.get(
  '/',
  requirePermission(PERMISSIONS.WALLETS_READ),
  adminWalletController.listWallets,
);

walletRouter.get(
  '/reconciliation',
  requirePermission(PERMISSIONS.WALLETS_READ),
  adminWalletController.reconcileWallets,
);

walletRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.WALLETS_READ),
  adminWalletController.getWalletById,
);

walletRouter.get(
  '/:id/transactions',
  requirePermission(PERMISSIONS.WALLETS_READ),
  adminWalletController.listWalletTransactions,
);

walletRouter.get(
  '/:id/earnings',
  requirePermission(PERMISSIONS.WALLETS_READ),
  adminWalletController.listWalletEarnings,
);

walletRouter.get(
  '/:id/payouts',
  requirePermission(PERMISSIONS.WALLETS_READ),
  adminWalletController.listWalletPayouts,
);

walletRouter.post(
  '/:id/adjust',
  // Balance mutation: requires a financial write permission, not read access
  requirePermission(PERMISSIONS.PAYOUTS_APPROVE),
  sensitiveOpLimiter,
  adminWalletController.adjustWallet,
);

// ══════════════════════════════════════════════════════════════════════════════
// 2. PAYOUT ROUTER (/api/v1/admin/payouts)
// ══════════════════════════════════════════════════════════════════════════════
const payoutRouter = express.Router();
payoutRouter.use(authenticate);
payoutRouter.use(requireRole(ROLES.ADMIN));
payoutRouter.use(auditMiddleware);

payoutRouter.get(
  '/',
  requirePermission(PERMISSIONS.PAYOUTS_READ),
  adminWalletController.listPayouts,
);

payoutRouter.get(
  '/reconciliation',
  requirePermission(PERMISSIONS.PAYOUTS_READ),
  adminWalletController.getPayoutReconciliation,
);

payoutRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.PAYOUTS_READ),
  adminWalletController.getPayoutById,
);

payoutRouter.get(
  '/:id/transactions',
  requirePermission(PERMISSIONS.PAYOUTS_READ),
  adminWalletController.getPayoutTransactions,
);

payoutRouter.get(
  '/:id/events',
  requirePermission(PERMISSIONS.PAYOUTS_READ),
  adminWalletController.getPayoutEvents,
);

payoutRouter.post(
  '/:id/approve',
  requirePermission(PERMISSIONS.PAYOUTS_APPROVE),
  sensitiveOpLimiter,
  adminWalletController.approvePayout,
);

payoutRouter.post(
  '/:id/mark-paid',
  requirePermission(PERMISSIONS.PAYOUTS_APPROVE),
  sensitiveOpLimiter,
  adminWalletController.markPaid,
);

payoutRouter.post(
  '/:id/reject',
  requirePermission(PERMISSIONS.PAYOUTS_APPROVE),
  sensitiveOpLimiter,
  adminWalletController.rejectPayout,
);

payoutRouter.post(
  '/:id/retry',
  requirePermission(PERMISSIONS.PAYOUTS_APPROVE),
  sensitiveOpLimiter,
  adminWalletController.retryPayout,
);

// ══════════════════════════════════════════════════════════════════════════════
// 3. BANK ACCOUNT ROUTER (/api/v1/admin/bank-accounts)
// ══════════════════════════════════════════════════════════════════════════════
const bankAccountRouter = express.Router();
bankAccountRouter.use(authenticate);
bankAccountRouter.use(requireRole(ROLES.ADMIN));
bankAccountRouter.use(auditMiddleware);

bankAccountRouter.get(
  '/',
  requirePermission(PERMISSIONS.WALLETS_READ),
  adminWalletController.listBankAccounts,
);

bankAccountRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.WALLETS_READ),
  adminWalletController.getBankAccountById,
);

// ══════════════════════════════════════════════════════════════════════════════
// 4. FINANCIALS RECONCILIATION ROUTER (/api/v1/admin/financials)
// ══════════════════════════════════════════════════════════════════════════════
const financialsRouter = express.Router();
financialsRouter.use(authenticate);
financialsRouter.use(requireRole(ROLES.ADMIN));
financialsRouter.use(auditMiddleware);

financialsRouter.get(
  '/reconciliation',
  requirePermission(PERMISSIONS.WALLETS_READ),
  adminWalletController.reconcileWallets,
);

module.exports = {
  walletRouter,
  payoutRouter,
  bankAccountRouter,
  financialsRouter,
};
