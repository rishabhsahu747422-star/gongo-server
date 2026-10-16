'use strict';

const WalletRepository = require('../repositories/wallet.repository');
const WalletTransactionRepository = require('../repositories/wallet-transaction.repository');
const { NotFoundError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

const commissionLockService = require('./commission-lock.service');

class WalletService {
  constructor(
    walletRepo = new WalletRepository(),
    walletTxRepo = new WalletTransactionRepository(),
  ) {
    this.walletRepository = walletRepo;
    this.walletTransactionRepository = walletTxRepo;
  }

  /**
   * Retrieves summary of partner's wallet including balances and totals.
   * Authoritative backend source for Available Balance and Hold Amount.
   *
   * @param {string} partnerId
   * @returns {Promise<object>}
   */
  async getWalletSummary(partnerId) {
    if (!partnerId) {
      return {
        walletId: null,
        partnerId: null,
        availableBalance: 0.00,
        holdAmount: 0.00,
        pendingBalance: 0.00,
        totalCredited: 0.00,
        totalDebited: 0.00,
        currency: 'INR',
        updatedAt: null,
      };
    }

    let wallet = await this.walletRepository.findByPartnerId(partnerId);
    if (!wallet && typeof this.walletRepository.createWallet === 'function') {
      try {
        await this.walletRepository.query(
          `INSERT INTO wallets (partner_id, available_balance, pending_balance, total_credited, total_debited, currency)
           VALUES ($1, 0.00, 0.00, 0.00, 0.00, 'INR')
           ON CONFLICT (partner_id) DO NOTHING`,
          [partnerId],
        );
        wallet = await this.walletRepository.findByPartnerId(partnerId);
      } catch {}
    }

    // 1. Ensure any partner bookings without locked commission snapshots are locked at booking creation time
    if (this.walletRepository && typeof this.walletRepository.query === 'function') {
      try {
        const uncalced = await this.walletRepository.query(
          `SELECT b.id
           FROM bookings b
           JOIN vehicles v ON v.id = b.vehicle_id
           LEFT JOIN commission_records cr ON cr.booking_id = b.id
           LEFT JOIN commission_transactions ct ON ct.booking_id = b.id
           LEFT JOIN earnings e ON e.booking_id = b.id
           WHERE (b.partner_id = $1 OR v.partner_id = $1)
             AND b.booking_status NOT IN ('CANCELLED', 'REFUNDED')
             AND COALESCE(b.status, '') NOT IN ('cancelled', 'refunded')
             AND cr.id IS NULL AND ct.id IS NULL AND (e.id IS NULL OR e.commission_amount = 0)
           LIMIT 20`,
          [partnerId]
        );
        if (uncalced?.rows?.length > 0) {
          for (const r of uncalced.rows) {
            await commissionLockService.lockBookingCommission(r.id);
          }
        }
      } catch {}

      // 2. Dynamic authoritative recalculation of Available Balance and Hold Amount
      try {
        const syncSql = `
          WITH b_earnings AS (
            SELECT
              COALESCE(SUM(CASE 
                WHEN b.booking_status = 'COMPLETED' OR COALESCE(b.status, '') IN ('completed', 'returned') 
                THEN COALESCE(e.partner_net_amount, cr.partner_payable_amount, ct.base_amount - ct.commission_amount, b.total_amount, 0) 
                ELSE 0 
              END), 0)::numeric(12,2) AS settled_earnings,
              COALESCE(SUM(CASE 
                WHEN (b.booking_status IN ('UPCOMING', 'CONFIRMED', 'ACTIVE', 'IN_PROGRESS', 'BOOKED') 
                      OR COALESCE(b.status, '') IN ('payment_completed', 'confirmed', 'pickup_scheduled', 'active', 'in_progress', 'vehicle_picked', 'booked'))
                     AND (b.booking_status != 'COMPLETED' AND COALESCE(b.status, '') NOT IN ('completed', 'returned'))
                THEN COALESCE(e.partner_net_amount, cr.partner_payable_amount, ct.base_amount - ct.commission_amount, b.total_amount, 0) 
                ELSE 0 
              END), 0)::numeric(12,2) AS hold_earnings
            FROM bookings b
            JOIN vehicles v ON v.id = b.vehicle_id
            LEFT JOIN earnings e ON e.booking_id = b.id
            LEFT JOIN commission_records cr ON cr.booking_id = b.id
            LEFT JOIN commission_transactions ct ON ct.booking_id = b.id
            WHERE (b.partner_id = $1 OR v.partner_id = $1)
              AND b.booking_status NOT IN ('CANCELLED', 'REFUNDED')
              AND COALESCE(b.status, '') NOT IN ('cancelled', 'refunded')
          ),
          p_debits AS (
            SELECT
              COALESCE(SUM(amount), 0)::numeric(12,2) AS total_payouts
            FROM (
              SELECT id, partner_id, amount, status FROM partner_payouts
              UNION
              SELECT id, partner_id, amount, status FROM payouts
            ) cp
            WHERE partner_id = $1
              AND UPPER(status) IN ('PENDING', 'REQUESTED', 'PROCESSING', 'COMPLETED', 'PAID')
          ),
          -- Manual Admin adjustments live only in the immutable ledger; include them so a
          -- recalculation does not erase them (earnings/payouts never contain them).
          a_adjustments AS (
            SELECT
              COALESCE(SUM(CASE WHEN LOWER(direction) = 'credit' THEN amount ELSE 0 END), 0)::numeric(12,2) AS adj_credit,
              COALESCE(SUM(CASE WHEN LOWER(direction) = 'debit' THEN amount ELSE 0 END), 0)::numeric(12,2) AS adj_debit
            FROM wallet_transactions
            WHERE partner_id = $1
              AND LOWER(transaction_type) = 'admin_adjustment'
              AND UPPER(COALESCE(status, 'COMPLETED')) = 'COMPLETED'
          )
          UPDATE wallets w
          SET
            available_balance = GREATEST(0.00, b_earnings.settled_earnings - p_debits.total_payouts
              + a_adjustments.adj_credit - a_adjustments.adj_debit),
            pending_balance = b_earnings.hold_earnings,
            total_credited = b_earnings.settled_earnings + a_adjustments.adj_credit,
            total_debited = p_debits.total_payouts + a_adjustments.adj_debit,
            updated_at = CURRENT_TIMESTAMP
          FROM b_earnings, p_debits, a_adjustments
          WHERE w.partner_id = $1
          RETURNING w.*;
        `;
        const syncRes = await this.walletRepository.query(syncSql, [partnerId]);
        if (syncRes && syncRes.rows && syncRes.rows[0]) {
          wallet = syncRes.rows[0];
        }

        // Keep partner_wallets table in parity if present
        try {
          await this.walletRepository.query(
            `UPDATE partner_wallets pw
             SET
               available_balance = $2,
               pending_balance = $3,
               total_earned = $4,
               total_paid_out = $5,
               total_credited = $4,
               total_debited = $5,
               updated_at = CURRENT_TIMESTAMP
             WHERE pw.partner_id = $1`,
            [
              partnerId,
              wallet?.available_balance || 0,
              wallet?.pending_balance || 0,
              wallet?.total_credited || 0,
              wallet?.total_debited || 0,
            ]
          );
        } catch {}
      } catch {}
    }

    const availableBalance = Number(Number(wallet?.available_balance || 0).toFixed(2));
    const holdAmount = Number(Number(wallet?.pending_balance || 0).toFixed(2));

    return {
      walletId: wallet?.id || null,
      partnerId: wallet?.partner_id || partnerId,
      availableBalance,
      holdAmount,
      pendingBalance: holdAmount, // Kept for backwards compatibility
      totalCredited: Number(Number(wallet?.total_credited || 0).toFixed(2)),
      totalDebited: Number(Number(wallet?.total_debited || 0).toFixed(2)),
      currency: wallet?.currency || 'INR',
      updatedAt: wallet?.updated_at || null,
    };
  }

  /**
   * Retrieves paginated, chronologically ordered transaction ledger records.
   *
   * @param {string} partnerId
   * @param {object} options
   * @returns {Promise<object>}
   */
  async getTransactionHistory(partnerId, options = {}) {
    // Ensure completed bookings have corresponding ledger transactions
    try {
      const syncTxSql = `
        INSERT INTO wallet_transactions (
          wallet_id,
          partner_id,
          transaction_type,
          direction,
          amount,
          balance_before,
          balance_after,
          reference_type,
          reference_id,
          status,
          description,
          metadata,
          created_at
        )
        SELECT
          w.id AS wallet_id,
          w.partner_id,
          'booking_earning' AS transaction_type,
          'credit' AS direction,
          COALESCE(e.partner_net_amount, cr.partner_payable_amount, b.total_amount, 0) AS amount,
          0.00 AS balance_before,
          COALESCE(e.partner_net_amount, cr.partner_payable_amount, b.total_amount, 0) AS balance_after,
          'booking' AS reference_type,
          b.id AS reference_id,
          'COMPLETED' AS status,
          'Booking Fare Credit #' || b.booking_number AS description,
          json_build_object(
            'bookingId', b.id,
            'bookingNumber', b.booking_number,
            'grossAmount', COALESCE(e.gross_amount, cr.gross_booking_amount, b.total_amount, 0),
            'commissionAmount', COALESCE(cr.commission_amount, e.commission_amount, 0),
            'commissionRate', COALESCE(cr.commission_rate, cr.rate, 0),
            'partnerNetAmount', COALESCE(e.partner_net_amount, cr.partner_payable_amount, b.total_amount, 0)
          )::jsonb AS metadata,
          COALESCE(b.updated_at, b.created_at) AS created_at
        FROM bookings b
        JOIN vehicles v ON v.id = b.vehicle_id
        JOIN wallets w ON w.partner_id = COALESCE(b.partner_id, v.partner_id)
        LEFT JOIN earnings e ON e.booking_id = b.id
        LEFT JOIN commission_records cr ON cr.booking_id = b.id
        WHERE (b.partner_id = $1 OR v.partner_id = $1)
          AND (b.booking_status = 'COMPLETED' OR COALESCE(b.status, '') IN ('completed', 'returned'))
          AND NOT EXISTS (
            SELECT 1 FROM wallet_transactions wt 
            WHERE wt.partner_id = w.partner_id AND wt.reference_id::text = b.id::text
          );
      `;
      await this.walletRepository.query(syncTxSql, [partnerId]);
    } catch (err) {
      this.logger?.warn?.(`Error syncing wallet transactions: ${err.message}`);
    }

    const { rows, total } = await this.walletTransactionRepository.findPaginatedByPartnerId(
      partnerId,
      options,
    );

    const items = rows.map((row) => {
      const meta = row.metadata || {};
      return {
        id: row.id,
        transactionType: row.transaction_type,
        // Stored lowercase; API contract (and the Partner app) uses CREDIT/DEBIT
        direction: row.direction ? String(row.direction).toUpperCase() : row.direction,
        amount: Number(Number(row.amount).toFixed(2)),
        balanceAfter: Number(Number(row.balance_after).toFixed(2)),
        referenceType: row.reference_type,
        referenceId: row.reference_id,
        status: row.status,
        description: row.description,
        metadata: meta,
        ...(meta.commissionAmount !== undefined ? {
          grossAmount: meta.grossAmount ? Number(meta.grossAmount) : undefined,
          commissionAmount: Number(meta.commissionAmount),
          commissionRate: meta.commissionRate !== undefined ? Number(meta.commissionRate) : undefined,
          partnerNetAmount: meta.partnerNetAmount !== undefined ? Number(meta.partnerNetAmount) : Number(Number(row.amount).toFixed(2)),
          partnerEarning: Number(Number(row.amount).toFixed(2)),
        } : {}),
        createdAt: row.created_at,
      };
    });

    const page = options.page || 1;
    const limit = options.limit || 20;
    const totalPages = Math.ceil(total / limit) || 1;

    return {
      items,
      pagination: {
        page,
        limit,
        totalItems: total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * Retrieves a single transaction audit record for the partner.
   * Enforces strict BOLA double-ownership.
   *
   * @param {string} partnerId
   * @param {string} transactionId
   * @returns {Promise<object>}
   */
  async getTransactionDetails(partnerId, transactionId) {
    const tx = await this.walletTransactionRepository.findByIdAndPartnerId(
      transactionId,
      partnerId,
    );

    if (!tx) {
      throw new NotFoundError(
        'Transaction not found or unauthorized',
        ERROR_CODES.NOT_FOUND,
      );
    }

    return {
      id: tx.id,
      walletId: tx.wallet_id,
      partnerId: tx.partner_id,
      transactionType: tx.transaction_type,
      direction: tx.direction ? String(tx.direction).toUpperCase() : tx.direction,
      amount: Number(Number(tx.amount).toFixed(2)),
      balanceAfter: Number(Number(tx.balance_after).toFixed(2)),
      referenceType: tx.reference_type,
      referenceId: tx.reference_id,
      status: tx.status,
      description: tx.description,
      metadata: tx.metadata || {},
      createdAt: tx.created_at,
    };
  }
}

module.exports = new WalletService();
