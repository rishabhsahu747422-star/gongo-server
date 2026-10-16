'use strict';

const logger = require('../../config/logger');
const adminWalletService = require('../../services/admin-wallet.service');
const adminPaymentService = require('../../services/admin-payment.service');

/**
 * Background Handler for Financial Reconciliation Jobs.
 *
 * Guarantees:
 * - Detects ledger discrepancies without silently mutating financial state
 * - Protects wallet ledger immutability
 * - Emits audit logs and alerts when anomalies are found
 * - Supports payment and payout gateway reconciliation
 */
async function handleReconciliationEvent(event) {
  const eventType = event.event_type;
  const payload = event.payload || {};

  logger.info('Executing financial reconciliation job', {
    eventId: event.id,
    eventType,
  });

  const summary = {
    eventType,
    timestamp: new Date().toISOString(),
  };

  // 1. Wallet & Ledger Reconciliation
  if (
    eventType === 'RECONCILIATION_RUN'
    || eventType === 'WALLET_AUDIT_CHECK'
    || !eventType.includes('PAYMENT')
  ) {
    const walletReconciliation = await adminWalletService.reconcileWallets();
    summary.walletReconciliation = {
      totalWallets: walletReconciliation.totalWallets,
      reconciledWallets: walletReconciliation.reconciledWallets,
      discrepancyCount: walletReconciliation.discrepancyCount,
      hasDiscrepancy: walletReconciliation.hasDiscrepancy,
    };

    if (walletReconciliation.hasDiscrepancy) {
      logger.error('CRITICAL: Wallet ledger discrepancy detected during background reconciliation', {
        discrepancyCount: walletReconciliation.discrepancyCount,
        discrepancies: walletReconciliation.discrepancies,
      });
    } else {
      logger.info('Wallet ledger reconciliation completed: 100% consistent', {
        totalWallets: walletReconciliation.totalWallets,
      });
    }
  }

  // 2. Payout Status Reconciliation
  if (eventType === 'RECONCILIATION_RUN' || eventType === 'PAYOUT_RECONCILIATION') {
    const payoutSummary = await adminWalletService.getPayoutReconciliation();
    summary.payoutSummary = payoutSummary;
  }

  // 3. Single Payment Gateway Reconciliation (if triggered for a specific payment)
  if (eventType === 'PAYMENT_RECONCILIATION' && (payload.paymentId || event.aggregate_id)) {
    const paymentId = payload.paymentId || event.aggregate_id;
    try {
      const paymentReconcileResult = await adminPaymentService.reconcilePayment(
        paymentId,
        { id: '00000000-0000-0000-0000-000000000000', role: 'SYSTEM' },
        { reason: 'Background automated payment reconciliation' },
      );
      summary.paymentReconcileResult = paymentReconcileResult;
    } catch (paymentErr) {
      logger.warn('Payment reconciliation check failed', {
        paymentId,
        error: paymentErr.message,
      });
      // Do not crash worker; record in summary
      summary.paymentReconcileError = paymentErr.message;
    }
  }

  return summary;
}

module.exports = {
  handleReconciliationEvent,
};
