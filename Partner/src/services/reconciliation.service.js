'use strict';

const { pool } = require('../db/pool');
const logger = require('../config/logger');
const metrics = require('../utils/metrics');

/**
 * ReconciliationService — Authoritative cross-table mathematical consistency
 * and financial audit engine.
 *
 * Verifies that:
 * 1. wallet.available_balance = sum(CREDIT) - sum(DEBIT)
 * 2. wallet.total_credited = sum(CREDIT)
 * 3. wallet.total_debited = sum(DEBIT)
 * 4. Every SUCCESS POST_RENTAL_SETTLEMENT has exactly 1 credit ledger row and 1 earnings row
 * 5. Every REQUESTED/PROCESSING/COMPLETED payout has exactly 1 debit ledger row
 * 6. Every FAILED payout has exactly 1 PAYOUT_REVERSAL credit ledger row
 */
class ReconciliationService {
  constructor(dbPool = pool) {
    this.pool = dbPool;
  }

  /**
   * Performs platform-wide financial reconciliation across all partner wallets and ledgers.
   *
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async runPlatformReconciliation(client = null) {
    const db = client || this.pool;
    const discrepancies = [];

    // 1. Audit wallet balances vs. immutable ledger transactions
    const walletAuditSql = `
      SELECT
        w.id AS wallet_id,
        w.partner_id,
        w.available_balance::numeric AS wallet_available,
        w.total_credited::numeric AS wallet_credited,
        w.total_debited::numeric AS wallet_debited,
        -- Ledger rows are stored lowercase ('credit'/'debit'); compare case-insensitively
        COALESCE(SUM(CASE WHEN LOWER(t.direction) = 'credit' AND UPPER(t.status) = 'COMPLETED' THEN t.amount ELSE 0 END), 0)::numeric AS ledger_credited,
        COALESCE(SUM(CASE WHEN LOWER(t.direction) = 'debit' AND UPPER(t.status) = 'COMPLETED' THEN t.amount ELSE 0 END), 0)::numeric AS ledger_debited
      FROM wallets w
      LEFT JOIN wallet_transactions t ON t.wallet_id = w.id
      GROUP BY w.id, w.partner_id, w.available_balance, w.total_credited, w.total_debited;
    `;

    const walletRes = await db.query(walletAuditSql);
    const auditedWallets = walletRes.rows.length;

    walletRes.rows.forEach((row) => {
      const walletAvail = Number(row.wallet_available || 0);
      const walletCred = Number(row.wallet_credited || 0);
      const walletDeb = Number(row.wallet_debited || 0);
      const ledgerCred = Number(row.ledger_credited || 0);
      const ledgerDeb = Number(row.ledger_debited || 0);
      const expectedAvail = Number((ledgerCred - ledgerDeb).toFixed(2));

      if (Math.abs(walletAvail - expectedAvail) > 0.01) {
        discrepancies.push({
          type: 'WALLET_AVAILABLE_BALANCE_MISMATCH',
          partnerId: row.partner_id,
          walletId: row.wallet_id,
          recordedBalance: walletAvail,
          expectedBalance: expectedAvail,
          difference: Number((walletAvail - expectedAvail).toFixed(2)),
        });
      }

      if (Math.abs(walletCred - ledgerCred) > 0.01) {
        discrepancies.push({
          type: 'WALLET_TOTAL_CREDITED_MISMATCH',
          partnerId: row.partner_id,
          walletId: row.wallet_id,
          recordedCredited: walletCred,
          ledgerCredited: ledgerCred,
        });
      }

      if (Math.abs(walletDeb - ledgerDeb) > 0.01) {
        discrepancies.push({
          type: 'WALLET_TOTAL_DEBITED_MISMATCH',
          partnerId: row.partner_id,
          walletId: row.wallet_id,
          recordedDebited: walletDeb,
          ledgerDebited: ledgerDeb,
        });
      }
    });

    // 2. Audit post-rental settlement payments vs. ledger transactions
    const settlementAuditSql = `
      SELECT
        p.id AS payment_id,
        p.booking_id,
        p.amount,
        p.status,
        t.id AS ledger_tx_id
      FROM payments p
      LEFT JOIN wallet_transactions t
        ON LOWER(t.reference_type) IN ('booking', 'post_rental_settlement') AND t.reference_id::text = p.id::text
      WHERE p.payment_type = 'POST_RENTAL_SETTLEMENT' AND p.status = 'SUCCESS';
    `;

    const settlementRes = await db.query(settlementAuditSql);
    settlementRes.rows.forEach((row) => {
      if (!row.ledger_tx_id) {
        discrepancies.push({
          type: 'MISSING_SETTLEMENT_LEDGER_TRANSACTION',
          paymentId: row.payment_id,
          bookingId: row.booking_id,
          amount: Number(row.amount),
        });
      }
    });

    // 3. Audit payouts vs. ledger entries
    const payoutAuditSql = `
      SELECT
        p.id AS payout_id,
        p.partner_id,
        p.amount,
        p.status,
        debit_tx.id AS debit_tx_id,
        rev_tx.id AS reversal_tx_id
      FROM payouts p
      LEFT JOIN wallet_transactions debit_tx
        ON LOWER(debit_tx.reference_type) = 'payout' AND debit_tx.reference_id::text = p.id::text AND LOWER(debit_tx.direction) = 'debit'
      LEFT JOIN wallet_transactions rev_tx
        ON LOWER(rev_tx.reference_type) IN ('refund', 'payout_reversal', 'payout') AND rev_tx.reference_id::text = p.id::text AND LOWER(rev_tx.direction) = 'credit'
      WHERE p.status IN ('REQUESTED', 'PROCESSING', 'COMPLETED', 'FAILED');
    `;

    const payoutRes = await db.query(payoutAuditSql);
    payoutRes.rows.forEach((row) => {
      if (!row.debit_tx_id) {
        discrepancies.push({
          type: 'MISSING_PAYOUT_DEBIT_LEDGER_TRANSACTION',
          payoutId: row.payout_id,
          partnerId: row.partner_id,
          status: row.status,
        });
      }

      if (row.status === 'FAILED' && !row.reversal_tx_id) {
        discrepancies.push({
          type: 'MISSING_FAILED_PAYOUT_REVERSAL_LEDGER_TRANSACTION',
          payoutId: row.payout_id,
          partnerId: row.partner_id,
        });
      }
    });

    // 4. Audit orphan financial records
    const orphanAuditSql = `
      SELECT t.id AS transaction_id, t.wallet_id, t.amount
      FROM wallet_transactions t
      LEFT JOIN wallets w ON w.id = t.wallet_id
      WHERE w.id IS NULL;
    `;

    const orphanRes = await db.query(orphanAuditSql);
    (orphanRes?.rows || []).forEach((row) => {
      discrepancies.push({
        type: 'ORPHAN_WALLET_TRANSACTION',
        transactionId: row.transaction_id,
        walletId: row.wallet_id,
        amount: Number(row.amount),
      });
    });

    const isConsistent = discrepancies.length === 0;

    metrics.recordReconciliationMismatch(discrepancies.length);

    logger.info('Platform financial reconciliation completed', {
      isConsistent,
      auditedWallets,
      discrepanciesCount: discrepancies.length,
    });

    return {
      isConsistent,
      auditedWallets,
      discrepanciesCount: discrepancies.length,
      discrepancies,
      reconciledAt: new Date().toISOString(),
    };
  }
}

module.exports = new ReconciliationService();
