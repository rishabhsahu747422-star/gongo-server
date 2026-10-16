'use strict';

const { query, transaction } = require('../db/pool');
const { escapeLikeString } = require('../db/sql-helpers');

let mockWalletResolver = null;

/**
 * wallet_transactions.transaction_type storage names (shared with Partner's ledger writer,
 * Partner/src/constants/wallet.js LEDGER_STORAGE_TYPE).
 */
const LEDGER_STORAGE_TYPE = Object.freeze({
  SETTLEMENT_PAYMENT: 'booking_earning',
  PAYOUT: 'payout',
  PAYOUT_REVERSAL: 'refund_adjustment',
  BOOKING_EARNING: 'booking_earning',
  REFUND_ADJUSTMENT: 'refund_adjustment',
  ADMIN_ADJUSTMENT: 'admin_adjustment',
  RECEIVABLE_RECOVERY: 'receivable_recovery',
});

/**
 * Lowercased transaction_type values matching a filter given as a domain or stored name
 * (stored form plus the legacy as-named form). Compare with LOWER(column) IN (...).
 *
 * @param {string} type
 * @returns {string[]}
 */
function ledgerTypeMatchValues(type) {
  const raw = String(type).trim();
  return [...new Set([LEDGER_STORAGE_TYPE[raw.toUpperCase()] || raw.toLowerCase(), raw.toLowerCase()])];
}

function setMockWalletResolver(resolver) {
  mockWalletResolver = resolver;
}

function resetMockWalletResolver() {
  mockWalletResolver = null;
}

class AdminWalletRepository {
  /**
   * Helper to route query through mock resolver if set, otherwise real DB pool/client.
   */
  async _exec(sql, params = [], client = null) {
    if (mockWalletResolver && typeof mockWalletResolver === 'function') {
      return mockWalletResolver(sql, params);
    }
    if (client) {
      return client.query(sql, params);
    }
    return query(sql, params);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // WALLETS
  // ══════════════════════════════════════════════════════════════════════════════

  async listWallets({
    search,
    walletId,
    partnerId,
    partnerName,
    status,
    availableMin,
    availableMax,
    pendingMin,
    pendingMax,
    currency,
    startDate,
    endDate,
    page = 1,
    limit = 20,
    sortBy = 'created_at',
    sortOrder = 'DESC',
  }) {
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (search && search.trim() !== '') {
      const escaped = `%${escapeLikeString(search.trim())}%`;
      conditions.push(`(
        p.business_name ILIKE $${paramIndex}
        OR u.name ILIKE $${paramIndex}
        OR u.phone ILIKE $${paramIndex}
        OR u.email ILIKE $${paramIndex}
        OR w.id::text ILIKE $${paramIndex}
        OR w.partner_id::text ILIKE $${paramIndex}
      )`);
      params.push(escaped);
      paramIndex += 1;
    }

    if (walletId) {
      conditions.push(`w.id = $${paramIndex}`);
      params.push(walletId);
      paramIndex += 1;
    }

    if (partnerId) {
      conditions.push(`w.partner_id = $${paramIndex}`);
      params.push(partnerId);
      paramIndex += 1;
    }

    if (partnerName && partnerName.trim() !== '') {
      const escaped = `%${escapeLikeString(partnerName.trim())}%`;
      conditions.push(`(p.business_name ILIKE $${paramIndex} OR u.name ILIKE $${paramIndex})`);
      params.push(escaped);
      paramIndex += 1;
    }

    if (status) {
      conditions.push(`p.status = $${paramIndex}`);
      params.push(status);
      paramIndex += 1;
    }

    if (currency) {
      conditions.push(`w.currency = $${paramIndex}`);
      params.push(currency);
      paramIndex += 1;
    }

    if (availableMin !== undefined && availableMin !== null) {
      conditions.push(`w.available_balance >= $${paramIndex}`);
      params.push(Number(availableMin));
      paramIndex += 1;
    }

    if (availableMax !== undefined && availableMax !== null) {
      conditions.push(`w.available_balance <= $${paramIndex}`);
      params.push(Number(availableMax));
      paramIndex += 1;
    }

    if (pendingMin !== undefined && pendingMin !== null) {
      conditions.push(`w.pending_balance >= $${paramIndex}`);
      params.push(Number(pendingMin));
      paramIndex += 1;
    }

    if (pendingMax !== undefined && pendingMax !== null) {
      conditions.push(`w.pending_balance <= $${paramIndex}`);
      params.push(Number(pendingMax));
      paramIndex += 1;
    }

    if (startDate) {
      conditions.push(`w.created_at >= $${paramIndex}`);
      params.push(startDate);
      paramIndex += 1;
    }

    if (endDate) {
      conditions.push(`w.created_at <= $${paramIndex}`);
      params.push(endDate);
      paramIndex += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const allowedSort = {
      available_balance: 'w.available_balance',
      pending_balance: 'w.pending_balance',
      total_credited: 'w.total_credited',
      total_debited: 'w.total_debited',
      created_at: 'w.created_at',
      updated_at: 'w.updated_at',
    };
    const sortCol = allowedSort[sortBy] || 'w.created_at';
    const sortDir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safeLimit;

    params.push(safeLimit);
    const limitParam = `$${paramIndex}`;
    paramIndex += 1;

    params.push(offset);
    const offsetParam = `$${paramIndex}`;

    const sql = `
      SELECT
        w.id,
        w.partner_id,
        w.available_balance,
        w.pending_balance,
        w.total_credited,
        w.total_debited,
        w.currency,
        w.created_at,
        w.updated_at,
        p.business_name AS partner_business_name,
        p.status AS partner_status,
        u.name AS partner_owner_name,
        u.phone AS partner_phone,
        u.email AS partner_email,
        COUNT(*) OVER()::int AS full_count
      FROM wallets w
      JOIN partners p ON p.id = w.partner_id
      JOIN users u ON u.id = p.user_id
      ${whereClause}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `;

    const result = await this._exec(sql, params);
    const total = result.rows.length > 0 ? result.rows[0].full_count : 0;

    const items = result.rows.map((row) => ({
      id: row.id,
      partnerId: row.partner_id,
      availableBalance: Number(Number(row.available_balance || 0).toFixed(2)),
      pendingBalance: Number(Number(row.pending_balance || 0).toFixed(2)),
      totalCredited: Number(Number(row.total_credited || 0).toFixed(2)),
      totalDebited: Number(Number(row.total_debited || 0).toFixed(2)),
      currency: row.currency || 'INR',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      partner: {
        id: row.partner_id,
        businessName: row.partner_business_name,
        ownerName: row.partner_owner_name,
        phone: row.partner_phone,
        email: row.partner_email,
        status: row.partner_status,
      },
    }));

    const totalPages = Math.ceil(total / safeLimit) || 1;

    return {
      items,
      pagination: {
        page: safePage,
        limit: safeLimit,
        totalItems: total,
        totalPages,
        hasNextPage: safePage < totalPages,
        hasPrevPage: safePage > 1,
      },
    };
  }

  async getWalletById(id) {
    const sql = `
      SELECT
        w.id,
        w.partner_id,
        w.available_balance,
        w.pending_balance,
        w.total_credited,
        w.total_debited,
        w.currency,
        w.created_at,
        w.updated_at,
        p.business_name AS partner_business_name,
        p.status AS partner_status,
        u.name AS partner_owner_name,
        u.phone AS partner_phone,
        u.email AS partner_email
      FROM wallets w
      JOIN partners p ON p.id = w.partner_id
      JOIN users u ON u.id = p.user_id
      WHERE w.id = $1 OR w.partner_id = $1
      LIMIT 1
    `;

    const res = await this._exec(sql, [id]);
    if (res.rows.length === 0) return null;

    const row = res.rows[0];
    return {
      id: row.id,
      partnerId: row.partner_id,
      availableBalance: Number(Number(row.available_balance || 0).toFixed(2)),
      pendingBalance: Number(Number(row.pending_balance || 0).toFixed(2)),
      totalCredited: Number(Number(row.total_credited || 0).toFixed(2)),
      totalDebited: Number(Number(row.total_debited || 0).toFixed(2)),
      currency: row.currency || 'INR',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      partner: {
        id: row.partner_id,
        businessName: row.partner_business_name,
        ownerName: row.partner_owner_name,
        phone: row.partner_phone,
        email: row.partner_email,
        status: row.partner_status,
      },
    };
  }

  async getWalletForUpdate(client, walletId) {
    const sql = 'SELECT * FROM wallets WHERE id = $1 FOR UPDATE';
    const res = await this._exec(sql, [walletId], client);
    return res.rows[0] || null;
  }

  async getWalletByPartnerIdForUpdate(client, partnerId) {
    const sql = 'SELECT * FROM wallets WHERE partner_id = $1 FOR UPDATE';
    const res = await this._exec(sql, [partnerId], client);
    return res.rows[0] || null;
  }

  async updateWalletBalances(client, walletId, {
    availableBalance,
    pendingBalance,
    totalCredited,
    totalDebited,
  }) {
    const sql = `
      UPDATE wallets
      SET
        available_balance = COALESCE($2, available_balance),
        pending_balance = COALESCE($3, pending_balance),
        total_credited = COALESCE($4, total_credited),
        total_debited = COALESCE($5, total_debited),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;

    const params = [
      walletId,
      availableBalance !== undefined ? Number(availableBalance) : null,
      pendingBalance !== undefined ? Number(pendingBalance) : null,
      totalCredited !== undefined ? Number(totalCredited) : null,
      totalDebited !== undefined ? Number(totalDebited) : null,
    ];

    const res = await this._exec(sql, params, client);
    return res.rows[0] || null;
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // WALLET TRANSACTIONS / LEDGER
  // ══════════════════════════════════════════════════════════════════════════════

  async listWalletTransactions(walletId, {
    transactionType,
    direction,
    status,
    startDate,
    endDate,
    search,
    page = 1,
    limit = 20,
    sortBy = 'created_at',
    sortOrder = 'DESC',
  }) {
    const conditions = ['wt.wallet_id = $1'];
    const params = [walletId];
    let paramIndex = 2;

    if (search && search.trim() !== '') {
      const escaped = `%${escapeLikeString(search.trim())}%`;
      conditions.push(`(
        wt.description ILIKE $${paramIndex}
        OR wt.reference_id ILIKE $${paramIndex}
        OR wt.transaction_type ILIKE $${paramIndex}
      )`);
      params.push(escaped);
      paramIndex += 1;
    }

    if (transactionType) {
      // Stored lowercase (admin_adjustment, payout, ...); accept domain or stored names
      const typeValues = ledgerTypeMatchValues(transactionType);
      conditions.push(`LOWER(wt.transaction_type) IN (${typeValues.map((_, i) => `$${paramIndex + i}`).join(", ")})`);
      params.push(...typeValues);
      paramIndex += typeValues.length;
    }

    if (direction) {
      conditions.push(`LOWER(wt.direction) = $${paramIndex}`);
      params.push(String(direction).toLowerCase());
      paramIndex += 1;
    }

    if (status) {
      conditions.push(`UPPER(wt.status) = $${paramIndex}`);
      params.push(status.toUpperCase());
      paramIndex += 1;
    }

    if (startDate) {
      conditions.push(`wt.created_at >= $${paramIndex}`);
      params.push(startDate);
      paramIndex += 1;
    }

    if (endDate) {
      conditions.push(`wt.created_at <= $${paramIndex}`);
      params.push(endDate);
      paramIndex += 1;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const allowedSort = {
      amount: 'wt.amount',
      balance_after: 'wt.balance_after',
      created_at: 'wt.created_at',
    };
    const sortCol = allowedSort[sortBy] || 'wt.created_at';
    const sortDir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safeLimit;

    params.push(safeLimit);
    const limitParam = `$${paramIndex}`;
    paramIndex += 1;

    params.push(offset);
    const offsetParam = `$${paramIndex}`;

    const sql = `
      SELECT
        wt.id,
        wt.wallet_id,
        wt.partner_id,
        wt.transaction_type,
        wt.direction,
        wt.amount,
        wt.balance_after,
        wt.reference_type,
        wt.reference_id,
        wt.status,
        wt.description,
        wt.metadata,
        wt.created_at,
        COUNT(*) OVER()::int AS full_count
      FROM wallet_transactions wt
      ${whereClause}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `;

    const result = await this._exec(sql, params);
    const total = result.rows.length > 0 ? result.rows[0].full_count : 0;

    const items = result.rows.map((row) => ({
      id: row.id,
      walletId: row.wallet_id,
      partnerId: row.partner_id,
      transactionType: row.transaction_type,
      direction: row.direction ? String(row.direction).toUpperCase() : row.direction,
      amount: Number(Number(row.amount || 0).toFixed(2)),
      balanceAfter: Number(Number(row.balance_after || 0).toFixed(2)),
      referenceType: row.reference_type,
      referenceId: row.reference_id,
      status: row.status,
      description: row.description,
      metadata: row.metadata || {},
      createdAt: row.created_at,
    }));

    const totalPages = Math.ceil(total / safeLimit) || 1;

    return {
      items,
      pagination: {
        page: safePage,
        limit: safeLimit,
        totalItems: total,
        totalPages,
        hasNextPage: safePage < totalPages,
        hasPrevPage: safePage > 1,
      },
    };
  }

  async createWalletTransaction(client, {
    walletId,
    partnerId,
    transactionType,
    direction,
    amount,
    balanceAfter,
    referenceType,
    referenceId,
    status = 'COMPLETED',
    description = null,
    metadata = {},
  }) {
    const sql = `
      INSERT INTO wallet_transactions (
        wallet_id,
        partner_id,
        transaction_type,
        direction,
        amount,
        balance_after,
        reference_type,
        reference_id,
        status,
        description,
        metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `;

    const params = [
      walletId,
      partnerId,
      transactionType,
      direction,
      Number(amount),
      Number(balanceAfter),
      referenceType,
      referenceId,
      status,
      description,
      metadata,
    ];

    const res = await this._exec(sql, params, client);
    return res.rows[0];
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // WALLET EARNINGS & PAYOUTS HISTORY
  // ══════════════════════════════════════════════════════════════════════════════

  async getWalletEarnings(partnerId, {
    settlementStatus,
    startDate,
    endDate,
    page = 1,
    limit = 20,
  }) {
    const conditions = ['e.partner_id = $1'];
    const params = [partnerId];
    let paramIndex = 2;

    if (settlementStatus) {
      conditions.push(`e.settlement_status = $${paramIndex}`);
      params.push(settlementStatus);
      paramIndex += 1;
    }

    if (startDate) {
      conditions.push(`e.created_at >= $${paramIndex}`);
      params.push(startDate);
      paramIndex += 1;
    }

    if (endDate) {
      conditions.push(`e.created_at <= $${paramIndex}`);
      params.push(endDate);
      paramIndex += 1;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safeLimit;

    params.push(safeLimit);
    const limitParam = `$${paramIndex}`;
    paramIndex += 1;

    params.push(offset);
    const offsetParam = `$${paramIndex}`;

    const sql = `
      SELECT
        e.id,
        e.partner_id,
        e.booking_id,
        b.booking_number,
        e.wallet_transaction_id,
        e.gross_amount,
        e.partner_net_amount,
        e.settlement_status,
        e.settled_at,
        e.created_at,
        e.updated_at,
        COUNT(*) OVER()::int AS full_count
      FROM earnings e
      LEFT JOIN bookings b ON b.id = e.booking_id
      ${whereClause}
      ORDER BY e.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `;

    const result = await this._exec(sql, params);
    const total = result.rows.length > 0 ? result.rows[0].full_count : 0;

    const items = result.rows.map((row) => ({
      id: row.id,
      partnerId: row.partner_id,
      bookingId: row.booking_id,
      bookingNumber: row.booking_number || null,
      walletTransactionId: row.wallet_transaction_id,
      grossAmount: Number(Number(row.gross_amount || 0).toFixed(2)),
      partnerNetAmount: Number(Number(row.partner_net_amount || 0).toFixed(2)),
      settlementStatus: row.settlement_status,
      settledAt: row.settled_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    const totalPages = Math.ceil(total / safeLimit) || 1;

    return {
      items,
      pagination: {
        page: safePage,
        limit: safeLimit,
        totalItems: total,
        totalPages,
        hasNextPage: safePage < totalPages,
        hasPrevPage: safePage > 1,
      },
    };
  }

  async getWalletPayouts(partnerId, {
    status,
    startDate,
    endDate,
    page = 1,
    limit = 20,
  }) {
    const conditions = ['p.partner_id = $1'];
    const params = [partnerId];
    let paramIndex = 2;

    if (status) {
      conditions.push(`p.status = $${paramIndex}`);
      params.push(status);
      paramIndex += 1;
    }

    if (startDate) {
      conditions.push(`p.requested_at >= $${paramIndex}`);
      params.push(startDate);
      paramIndex += 1;
    }

    if (endDate) {
      conditions.push(`p.requested_at <= $${paramIndex}`);
      params.push(endDate);
      paramIndex += 1;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safeLimit;

    params.push(safeLimit);
    const limitParam = `$${paramIndex}`;
    paramIndex += 1;

    params.push(offset);
    const offsetParam = `$${paramIndex}`;

    const sql = `
      SELECT
        p.id,
        p.partner_id,
        p.bank_account_id,
        ba.account_number_masked,
        ba.bank_name,
        ba.ifsc_code,
        ba.account_holder_name,
        p.amount,
        p.status,
        p.provider_transfer_id,
        p.failure_reason,
        p.idempotency_key,
        p.requested_at,
        p.processed_at,
        p.created_at,
        p.updated_at,
        COUNT(*) OVER()::int AS full_count
      FROM payouts p
      LEFT JOIN partner_bank_accounts ba ON ba.id = p.bank_account_id
      ${whereClause}
      ORDER BY p.requested_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `;

    const result = await this._exec(sql, params);
    const total = result.rows.length > 0 ? result.rows[0].full_count : 0;

    const items = result.rows.map((row) => ({
      id: row.id,
      partnerId: row.partner_id,
      bankAccountId: row.bank_account_id,
      bankAccount: row.account_number_masked ? {
        accountHolderName: row.account_holder_name,
        accountNumberMasked: row.account_number_masked,
        bankName: row.bank_name,
        ifscCode: row.ifsc_code,
      } : null,
      amount: Number(Number(row.amount || 0).toFixed(2)),
      status: row.status,
      providerTransferId: row.provider_transfer_id || null,
      failureReason: row.failure_reason || null,
      idempotencyKey: row.idempotency_key || null,
      requestedAt: row.requested_at,
      processedAt: row.processed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    const totalPages = Math.ceil(total / safeLimit) || 1;

    return {
      items,
      pagination: {
        page: safePage,
        limit: safeLimit,
        totalItems: total,
        totalPages,
        hasNextPage: safePage < totalPages,
        hasPrevPage: safePage > 1,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // WALLET INTEGRITY & RECONCILIATION
  // ══════════════════════════════════════════════════════════════════════════════

  async reconcileWallets() {
    const sql = `
      SELECT
        w.id AS wallet_id,
        w.partner_id,
        p.business_name AS partner_business_name,
        w.available_balance AS stored_available_balance,
        w.pending_balance AS stored_pending_balance,
        w.total_credited AS stored_total_credited,
        w.total_debited AS stored_total_debited,
        COALESCE(SUM(
          CASE
            WHEN LOWER(wt.direction) = 'credit' THEN wt.amount
            WHEN LOWER(wt.direction) = 'debit' THEN -wt.amount
            ELSE 0
          END
        ), 0.00)::numeric(12,2) AS ledger_calculated_balance,
        COALESCE(SUM(
          CASE WHEN LOWER(wt.direction) = 'credit' THEN wt.amount ELSE 0 END
        ), 0.00)::numeric(12,2) AS ledger_total_credits,
        COALESCE(SUM(
          CASE WHEN LOWER(wt.direction) = 'debit' THEN wt.amount ELSE 0 END
        ), 0.00)::numeric(12,2) AS ledger_total_debits,
        COUNT(wt.id)::int AS transaction_count
      FROM wallets w
      JOIN partners p ON p.id = w.partner_id
      LEFT JOIN wallet_transactions wt ON wt.wallet_id = w.id AND wt.status = 'COMPLETED'
      GROUP BY
        w.id,
        w.partner_id,
        p.business_name,
        w.available_balance,
        w.pending_balance,
        w.total_credited,
        w.total_debited
      ORDER BY w.created_at ASC
    `;

    const res = await this._exec(sql);

    const discrepancies = [];
    let totalWallets = 0;
    let reconciledWallets = 0;
    let totalStoredBalance = 0;
    let totalLedgerBalance = 0;

    res.rows.forEach((row) => {
      totalWallets += 1;
      const stored = Number(row.stored_available_balance || 0);
      const ledger = Number(row.ledger_calculated_balance || 0);
      const diff = Math.round((stored - ledger) * 100) / 100;

      totalStoredBalance += stored;
      totalLedgerBalance += ledger;

      if (Math.abs(diff) > 0.01) {
        discrepancies.push({
          walletId: row.wallet_id,
          partnerId: row.partner_id,
          partnerName: row.partner_business_name,
          storedBalance: stored,
          ledgerBalance: ledger,
          difference: diff,
          transactionCount: row.transaction_count,
        });
      } else {
        reconciledWallets += 1;
      }
    });

    return {
      totalWallets,
      reconciledWallets,
      discrepancyCount: discrepancies.length,
      totalStoredBalance: Number(totalStoredBalance.toFixed(2)),
      totalLedgerBalance: Number(totalLedgerBalance.toFixed(2)),
      hasDiscrepancy: discrepancies.length > 0,
      discrepancies,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // BANK ACCOUNTS (SAFE PROJECTION)
  // ══════════════════════════════════════════════════════════════════════════════

  async listBankAccounts({
    partnerId,
    verificationStatus,
    search,
    page = 1,
    limit = 20,
    sortBy = 'created_at',
    sortOrder = 'DESC',
  }) {
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (partnerId) {
      conditions.push(`ba.partner_id = $${paramIndex}`);
      params.push(partnerId);
      paramIndex += 1;
    }

    if (verificationStatus) {
      conditions.push(`ba.verification_status = $${paramIndex}`);
      params.push(verificationStatus);
      paramIndex += 1;
    }

    if (search && search.trim() !== '') {
      const escaped = `%${escapeLikeString(search.trim())}%`;
      conditions.push(`(
        ba.account_holder_name ILIKE $${paramIndex}
        OR ba.bank_name ILIKE $${paramIndex}
        OR ba.ifsc_code ILIKE $${paramIndex}
        OR ba.account_number_masked ILIKE $${paramIndex}
        OR p.business_name ILIKE $${paramIndex}
      )`);
      params.push(escaped);
      paramIndex += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const allowedSort = {
      created_at: 'ba.created_at',
      bank_name: 'ba.bank_name',
      verification_status: 'ba.verification_status',
    };
    const sortCol = allowedSort[sortBy] || 'ba.created_at';
    const sortDir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safeLimit;

    params.push(safeLimit);
    const limitParam = `$${paramIndex}`;
    paramIndex += 1;

    params.push(offset);
    const offsetParam = `$${paramIndex}`;

    // Note: NEVER select account_number_encrypted!
    const sql = `
      SELECT
        ba.id,
        ba.partner_id,
        ba.account_holder_name,
        ba.account_number_masked,
        ba.ifsc_code,
        ba.bank_name,
        ba.is_primary,
        ba.verification_status,
        ba.created_at,
        ba.updated_at,
        p.business_name AS partner_business_name,
        COUNT(*) OVER()::int AS full_count
      FROM partner_bank_accounts ba
      JOIN partners p ON p.id = ba.partner_id
      ${whereClause}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `;

    const result = await this._exec(sql, params);
    const total = result.rows.length > 0 ? result.rows[0].full_count : 0;

    const items = result.rows.map((row) => ({
      id: row.id,
      partnerId: row.partner_id,
      partnerBusinessName: row.partner_business_name,
      accountHolderName: row.account_holder_name,
      accountNumberMasked: row.account_number_masked,
      ifscCode: row.ifsc_code,
      bankName: row.bank_name,
      isPrimary: row.is_primary,
      verificationStatus: row.verification_status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    const totalPages = Math.ceil(total / safeLimit) || 1;

    return {
      items,
      pagination: {
        page: safePage,
        limit: safeLimit,
        totalItems: total,
        totalPages,
        hasNextPage: safePage < totalPages,
        hasPrevPage: safePage > 1,
      },
    };
  }

  async getBankAccountById(id) {
    const sql = `
      SELECT
        ba.id,
        ba.partner_id,
        ba.account_holder_name,
        ba.account_number_masked,
        ba.ifsc_code,
        ba.bank_name,
        ba.is_primary,
        ba.verification_status,
        ba.created_at,
        ba.updated_at,
        p.business_name AS partner_business_name
      FROM partner_bank_accounts ba
      JOIN partners p ON p.id = ba.partner_id
      WHERE ba.id = $1
      LIMIT 1
    `;

    const res = await this._exec(sql, [id]);
    if (res.rows.length === 0) return null;

    const row = res.rows[0];
    return {
      id: row.id,
      partnerId: row.partner_id,
      partnerBusinessName: row.partner_business_name,
      accountHolderName: row.account_holder_name,
      accountNumberMasked: row.account_number_masked,
      ifscCode: row.ifsc_code,
      bankName: row.bank_name,
      isPrimary: row.is_primary,
      verificationStatus: row.verification_status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // PAYOUTS
  // ══════════════════════════════════════════════════════════════════════════════

  async listPayouts({
    payoutId,
    partnerId,
    bankAccountId,
    status,
    amountMin,
    amountMax,
    search,
    startDate,
    endDate,
    page = 1,
    limit = 20,
    sortBy = 'created_at',
    sortOrder = 'DESC',
  }) {
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (search && search.trim() !== '') {
      const escaped = `%${escapeLikeString(search.trim())}%`;
      conditions.push(`(
        part.business_name ILIKE $${paramIndex}
        OR u.name ILIKE $${paramIndex}
        OR u.phone ILIKE $${paramIndex}
        OR ba.bank_name ILIKE $${paramIndex}
        OR ba.ifsc_code ILIKE $${paramIndex}
        OR ba.account_number_masked ILIKE $${paramIndex}
        OR p.provider_transfer_id ILIKE $${paramIndex}
        OR p.id::text ILIKE $${paramIndex}
      )`);
      params.push(escaped);
      paramIndex += 1;
    }

    if (payoutId) {
      conditions.push(`p.id = $${paramIndex}`);
      params.push(payoutId);
      paramIndex += 1;
    }

    if (partnerId) {
      conditions.push(`p.partner_id = $${paramIndex}`);
      params.push(partnerId);
      paramIndex += 1;
    }

    if (bankAccountId) {
      conditions.push(`p.bank_account_id = $${paramIndex}`);
      params.push(bankAccountId);
      paramIndex += 1;
    }

    if (status) {
      const up = status.toUpperCase();
      if (up === 'PENDING' || up === 'REQUESTED') {
        conditions.push(`(p.status = 'pending' OR p.status = 'requested')`);
      } else if (up === 'PAID' || up === 'COMPLETED') {
        conditions.push(`(p.status = 'paid' OR p.status = 'completed')`);
      } else if (up === 'REJECTED' || up === 'FAILED') {
        conditions.push(`(p.status = 'rejected' OR p.status = 'failed')`);
      } else if (up === 'CANCELLED') {
        conditions.push(`p.status = 'cancelled'`);
      } else {
        conditions.push(`p.status = $${paramIndex}`);
        params.push(status.toLowerCase());
        paramIndex += 1;
      }
    }

    if (amountMin !== undefined && amountMin !== null) {
      conditions.push(`p.amount >= $${paramIndex}`);
      params.push(Number(amountMin));
      paramIndex += 1;
    }

    if (amountMax !== undefined && amountMax !== null) {
      conditions.push(`p.amount <= $${paramIndex}`);
      params.push(Number(amountMax));
      paramIndex += 1;
    }

    if (startDate) {
      conditions.push(`p.requested_at >= $${paramIndex}`);
      params.push(startDate);
      paramIndex += 1;
    }

    if (endDate) {
      conditions.push(`p.requested_at <= $${paramIndex}`);
      params.push(endDate);
      paramIndex += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const allowedSort = {
      amount: 'p.amount',
      status: 'p.status',
      requested_at: 'p.requested_at',
      processed_at: 'p.processed_at',
      created_at: 'p.created_at',
    };
    const sortCol = allowedSort[sortBy] || 'p.created_at';
    const sortDir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safeLimit;

    params.push(safeLimit);
    const limitParam = `$${paramIndex}`;
    paramIndex += 1;

    params.push(offset);
    const offsetParam = `$${paramIndex}`;

    const sql = `
      SELECT
        p.id,
        p.payout_number,
        p.partner_id,
        p.bank_account_id,
        p.amount,
        p.status,
        p.provider_transfer_id,
        p.payment_reference,
        p.payment_method,
        p.notes,
        p.processed_by,
        p.failure_reason,
        p.idempotency_key,
        p.requested_at,
        p.processed_at,
        p.completed_at,
        p.created_at,
        p.updated_at,
        part.business_name AS partner_business_name,
        part.partner_code,
        u.name AS partner_owner_name,
        COALESCE(u.phone, part.contact_phone) AS partner_phone,
        ba.account_number_masked,
        ba.bank_name,
        ba.ifsc_code,
        ba.upi_id,
        ba.account_holder_name,
        w.id AS wallet_id,
        w.available_balance AS wallet_available_balance,
        COUNT(*) OVER()::int AS full_count
      FROM payouts p
      JOIN partners part ON part.id = p.partner_id
      LEFT JOIN users u ON u.id = part.user_id
      LEFT JOIN partner_bank_accounts ba ON ba.id = p.bank_account_id
      LEFT JOIN partner_wallets w ON w.partner_id = p.partner_id
      ${whereClause}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `;

    const result = await this._exec(sql, params);
    const total = result.rows.length > 0 ? result.rows[0].full_count : 0;

    const items = result.rows.map((row) => {
      const raw = (row.status || '').toLowerCase();
      let displayStatus = 'PENDING';
      if (raw === 'completed' || raw === 'paid') {
        displayStatus = 'PAID';
      } else if (raw === 'failed' || raw === 'rejected') {
        displayStatus = 'REJECTED';
      } else if (raw === 'cancelled') {
        displayStatus = 'CANCELLED';
      } else if (raw === 'processing') {
        displayStatus = 'PROCESSING';
      } else if (raw === 'approved') {
        displayStatus = 'APPROVED';
      } else {
        displayStatus = 'PENDING';
      }

      const ref = row.payment_reference || row.provider_transfer_id || null;

      return {
        id: row.id,
        payoutNumber: row.payout_number || `PO-${String(row.id).slice(0, 8)}`,
        partnerId: row.partner_id,
        partnerName: row.partner_business_name || row.partner_owner_name || 'Partner',
        partnerCode: row.partner_code || null,
        partner: {
          id: row.partner_id,
          businessName: row.partner_business_name,
          ownerName: row.partner_owner_name,
          phone: row.partner_phone,
          partnerCode: row.partner_code || null,
        },
        wallet: {
          id: row.wallet_id,
          availableBalance: Number(Number(row.wallet_available_balance || 0).toFixed(2)),
        },
        availableBalance: Number(Number(row.wallet_available_balance || 0).toFixed(2)),
        bankAccount: {
          id: row.bank_account_id,
          accountHolderName: row.account_holder_name,
          accountNumberMasked: row.account_number_masked,
          bankName: row.bank_name,
          ifscCode: row.ifsc_code,
          upiId: row.upi_id || null,
        },
        amount: Number(Number(row.amount || 0).toFixed(2)),
        status: displayStatus,
        rawStatus: row.status,
        paymentReference: ref,
        providerTransferId: ref,
        paymentMethod: row.payment_method || null,
        notes: row.notes || null,
        processedBy: row.processed_by || null,
        failureReason: row.failure_reason || null,
        idempotencyKey: row.idempotency_key || null,
        requestedAt: row.requested_at,
        processedAt: row.processed_at || row.completed_at || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });

    const totalPages = Math.ceil(total / safeLimit) || 1;

    return {
      items,
      pagination: {
        page: safePage,
        limit: safeLimit,
        totalItems: total,
        totalPages,
        hasNextPage: safePage < totalPages,
        hasPrevPage: safePage > 1,
      },
    };
  }

  async getPayoutById(id) {
    const sql = `
      SELECT
        p.id,
        p.payout_number,
        p.partner_id,
        p.bank_account_id,
        p.amount,
        p.status,
        p.provider_transfer_id,
        p.payment_reference,
        p.payment_method,
        p.notes,
        p.processed_by,
        p.failure_reason,
        p.idempotency_key,
        p.requested_at,
        p.processed_at,
        p.completed_at,
        p.created_at,
        p.updated_at,
        part.partner_code,
        part.business_name AS partner_business_name,
        part.status AS partner_status,
        u.name AS partner_owner_name,
        COALESCE(u.phone, part.contact_phone) AS partner_phone,
        COALESCE(u.email, part.contact_email) AS partner_email,
        s.name AS shop_name,
        ba.account_number_masked,
        ba.bank_name,
        ba.ifsc_code,
        ba.upi_id,
        ba.account_holder_name,
        ba.verification_status AS bank_verification_status,
        w.id AS wallet_id,
        w.available_balance AS wallet_available_balance,
        w.pending_balance AS wallet_pending_balance,
        w.receivable_balance AS wallet_receivable_balance,
        w.total_earned AS wallet_total_earned,
        w.total_paid_out AS wallet_total_paid_out,
        w.total_debited AS wallet_total_debited,
        w.currency AS wallet_currency
      FROM payouts p
      JOIN partners part ON part.id = p.partner_id
      LEFT JOIN users u ON u.id = part.user_id
      LEFT JOIN partner_bank_accounts ba ON ba.id = p.bank_account_id
      LEFT JOIN partner_wallets w ON w.partner_id = p.partner_id
      LEFT JOIN LATERAL (SELECT name FROM shops WHERE partner_id = p.partner_id ORDER BY created_at ASC LIMIT 1) s ON true
      WHERE p.id = $1
      LIMIT 1
    `;

    const res = await this._exec(sql, [id]);
    if (res.rows.length === 0) return null;

    const row = res.rows[0];
    const rawStatus = (row.status || '').toLowerCase();
    let displayStatus = 'PENDING';
    if (rawStatus === 'completed' || rawStatus === 'paid') {
      displayStatus = 'PAID';
    } else if (rawStatus === 'failed' || rawStatus === 'rejected') {
      displayStatus = 'REJECTED';
    } else if (rawStatus === 'cancelled') {
      displayStatus = 'CANCELLED';
    } else if (rawStatus === 'processing') {
      displayStatus = 'PROCESSING';
    } else if (rawStatus === 'approved') {
      displayStatus = 'APPROVED';
    } else {
      displayStatus = 'PENDING';
    }

    const ref = row.payment_reference || row.provider_transfer_id || null;

    return {
      id: row.id,
      payoutNumber: row.payout_number || `PO-${String(row.id).slice(0, 8)}`,
      partnerId: row.partner_id,
      partnerName: row.partner_business_name || row.partner_owner_name || 'Partner',
      partnerCode: row.partner_code || null,
      shopName: row.shop_name || null,
      partner: {
        id: row.partner_id,
        partnerCode: row.partner_code || null,
        businessName: row.partner_business_name,
        ownerName: row.partner_owner_name,
        phone: row.partner_phone,
        email: row.partner_email,
        status: row.partner_status,
        shopName: row.shop_name || null,
      },
      wallet: {
        id: row.wallet_id,
        availableBalance: Number(Number(row.wallet_available_balance || 0).toFixed(2)),
        pendingBalance: Number(Number(row.wallet_pending_balance || 0).toFixed(2)),
        receivableBalance: Number(Number(row.wallet_receivable_balance || 0).toFixed(2)),
        totalEarned: Number(Number(row.wallet_total_earned || 0).toFixed(2)),
        totalWithdrawn: Number(Number(row.wallet_total_paid_out || row.wallet_total_debited || 0).toFixed(2)),
        currency: row.wallet_currency || 'INR',
      },
      availableBalance: Number(Number(row.wallet_available_balance || 0).toFixed(2)),
      bankAccount: {
        id: row.bank_account_id,
        accountHolderName: row.account_holder_name,
        accountNumberMasked: row.account_number_masked,
        bankName: row.bank_name,
        ifscCode: row.ifsc_code,
        upiId: row.upi_id || null,
        verificationStatus: row.bank_verification_status,
      },
      amount: Number(Number(row.amount || 0).toFixed(2)),
      status: displayStatus,
      rawStatus: row.status,
      paymentReference: ref,
      providerTransferId: ref,
      paymentMethod: row.payment_method || null,
      notes: row.notes || null,
      processedBy: row.processed_by || null,
      failureReason: row.failure_reason || null,
      rejectionReason: row.failure_reason || null,
      idempotencyKey: row.idempotency_key || null,
      requestedAt: row.requested_at,
      processedAt: row.processed_at || row.completed_at || null,
      paidAt: (displayStatus === 'PAID') ? (row.processed_at || row.completed_at || row.updated_at) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async getPayoutForUpdate(client, payoutId) {
    const sql = 'SELECT * FROM partner_payouts WHERE id = $1 FOR UPDATE';
    const res = await this._exec(sql, [payoutId], client);
    return res.rows[0] || null;
  }

  /**
   * Payout balance model (owned by Partner/src/services/payout.service.js): the amount is
   * debited from the partner's available balance when the payout is REQUESTED (both
   * `wallets` and its `partner_wallets` mirror), and a failed/reversed transfer credits it
   * back (Partner payment.service reverseDebitWallet). Admin actions follow the same model:
   * mark-paid moves no money, reject releases the hold (+amount), retry re-applies it (-amount).
   *
   * @param {import('pg').PoolClient} client
   * @param {string} partnerId
   * @param {number} delta Positive credits the partner back; negative re-debits
   */
  /**
   * Locks a partner_wallets row by its id (the wallet id the Admin API exposes).
   *
   * @param {import('pg').PoolClient} client
   * @param {string} walletId
   * @returns {Promise<object|null>}
   */
  async getWalletByIdForUpdate(client, walletId) {
    const res = await this._exec(
      `SELECT id, partner_id, available_balance, pending_balance, total_credited, total_debited, currency
       FROM partner_wallets
       WHERE id = $1
       FOR UPDATE`,
      [walletId],
      client,
    );
    return res.rows[0] || null;
  }

  /**
   * Applies a manual admin credit (+) or debit (-) to the partner's available balance in
   * both `wallets` (Partner's source of truth) and the `partner_wallets` mirror, so the
   * adjustment survives Partner's balance recalculation from `wallets`.
   *
   * @param {import('pg').PoolClient} client
   * @param {string} partnerId
   * @param {number} delta
   */
  /**
   * Existing manual adjustment ledger row for an idempotency key (stored as reference_id).
   *
   * @param {import('pg').PoolClient} client
   * @param {string} partnerId
   * @param {string} idempotencyKey
   * @returns {Promise<object|null>}
   */
  async findAdminAdjustmentByKey(client, partnerId, idempotencyKey) {
    const res = await this._exec(
      `SELECT id, amount, direction, balance_before, balance_after, description, created_at
       FROM wallet_transactions
       WHERE partner_id = $1
         AND LOWER(transaction_type) = 'admin_adjustment'
         AND reference_id = $2
       LIMIT 1`,
      [partnerId, idempotencyKey],
      client,
    );
    return res.rows[0] || null;
  }

  async adjustAvailableBalance(client, partnerId, delta) {
    const amount = Math.round(Number(delta) * 100) / 100;
    const credit = amount > 0 ? amount : 0;
    const debit = amount < 0 ? -amount : 0;
    const res = await this._exec(
      `UPDATE wallets
       SET available_balance = available_balance + $1,
           total_credited = total_credited + $2,
           total_debited = total_debited + $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE partner_id = $4
       RETURNING id`,
      [amount, credit, debit, partnerId],
      client,
    );
    if (!res.rows || res.rows.length === 0) {
      throw new Error('Partner wallet not found for balance adjustment');
    }
    await this._syncPartnerWalletsMirror(client, partnerId, 0);
  }

  async adjustPayoutHold(client, partnerId, delta) {
    const amount = Math.round(Number(delta) * 100) / 100;
    const res = await this._exec(
      `UPDATE wallets
       SET available_balance = available_balance + $1,
           total_debited = GREATEST(0, total_debited - $1),
           updated_at = CURRENT_TIMESTAMP
       WHERE partner_id = $2
       RETURNING id`,
      [amount, partnerId],
      client,
    );
    if (!res.rows || res.rows.length === 0) {
      throw new Error('Partner wallet not found for payout hold adjustment');
    }
    // total_paid_out is not part of the `wallets` view, so it takes the delta here
    await this._syncPartnerWalletsMirror(client, partnerId, -amount);
  }

  /**
   * Copies balances just written to `wallets` into partner_wallets instead of re-applying
   * the delta. In the live Supabase layout `wallets` is a view over partner_wallets
   * (Partner/scripts/apply_supabase_alignment.js), so applying a delta to both would change
   * the same row twice; in a two-table layout the copy keeps the mirror in sync.
   *
   * @param {import('pg').PoolClient} client
   * @param {string} partnerId
   * @param {number} paidOutDelta change to partner_wallets.total_paid_out (0 for none)
   */
  async _syncPartnerWalletsMirror(client, partnerId, paidOutDelta) {
    await this._exec(
      `UPDATE partner_wallets
       SET available_balance = (SELECT w.available_balance FROM wallets w WHERE w.partner_id = $1 LIMIT 1),
           total_credited = (SELECT w.total_credited FROM wallets w WHERE w.partner_id = $1 LIMIT 1),
           total_debited = (SELECT w.total_debited FROM wallets w WHERE w.partner_id = $1 LIMIT 1),
           total_paid_out = GREATEST(0, COALESCE(total_paid_out, 0) + $2),
           updated_at = CURRENT_TIMESTAMP
       WHERE partner_id = $1
         AND EXISTS (SELECT 1 FROM wallets w WHERE w.partner_id = $1)`,
      [partnerId, Math.round(Number(paidOutDelta) * 100) / 100],
      client,
    );
  }

  async getWalletByPartnerIdForUpdate(client, partnerId) {
    const sql = `
      SELECT id, partner_id, available_balance, pending_balance, receivable_balance, total_earned, total_paid_out, total_credited, total_debited, currency, created_at, updated_at
      FROM partner_wallets
      WHERE partner_id = $1
      FOR UPDATE
    `;
    const res = await this._exec(sql, [partnerId], client);
    return res.rows[0] || null;
  }

  async updateWalletBalances(client, walletId, { availableBalance, totalDebited, totalCredited }) {
    const sets = [];
    const params = [walletId];
    let pIdx = 2;

    if (availableBalance !== undefined) {
      sets.push(`available_balance = $${pIdx}`);
      params.push(availableBalance);
      pIdx += 1;
    }
    if (totalDebited !== undefined) {
      sets.push(`total_debited = $${pIdx}`);
      params.push(totalDebited);
      pIdx += 1;
    }
    if (totalCredited !== undefined) {
      sets.push(`total_credited = $${pIdx}`);
      params.push(totalCredited);
      pIdx += 1;
    }

    sets.push('updated_at = CURRENT_TIMESTAMP');

    const sql = `
      UPDATE partner_wallets
      SET ${sets.join(', ')}
      WHERE id = $1
      RETURNING *
    `;
    const res = await this._exec(sql, params, client);
    return res.rows[0] || null;
  }

  async createWalletTransaction(client, {
    walletId,
    partnerId,
    transactionType,
    direction,
    amount,
    balanceBefore = null,
    balanceAfter,
    referenceType = 'payout',
    referenceId,
    status = 'COMPLETED',
    description = null,
    metadata = {},
  }) {
    const numAmount = Number(amount);
    const numBalanceAfter = Number(balanceAfter);
    const numBalanceBefore = balanceBefore !== null && balanceBefore !== undefined
      ? Number(balanceBefore)
      : (String(direction).toLowerCase() === 'debit'
        ? numBalanceAfter + numAmount
        : numBalanceAfter - numAmount);

    // Storage vocabulary shared with Partner (Partner/src/constants/wallet.js):
    // direction is stored lowercase 'credit'/'debit'. Anything else is a bug — reject it
    // before writing rather than defaulting to a debit.
    const dbDirection = String(direction || '').toLowerCase();
    if (dbDirection !== 'credit' && dbDirection !== 'debit') {
      throw new Error(`Invalid ledger direction: ${direction}`);
    }
    if (referenceId === null || referenceId === undefined || referenceId === '') {
      throw new Error('Ledger entries require a reference id');
    }

    const typeMap = {
      PAYOUT: 'payout',
      PAYOUT_REVERSAL: 'refund_adjustment',
      BOOKING_EARNING: 'booking_earning',
      REFUND_ADJUSTMENT: 'refund_adjustment',
      ADMIN_ADJUSTMENT: 'admin_adjustment',
      RECEIVABLE_RECOVERY: 'receivable_recovery',
    };
    const dbTxType = typeMap[transactionType] || (transactionType || 'payout').toLowerCase();

    const refMap = {
      PAYOUT: 'payout',
      BOOKING: 'booking',
      REFUND: 'refund',
      ADMIN: 'admin',
    };
    const dbRefType = refMap[referenceType] || (referenceType ? referenceType.toLowerCase() : 'payout');

    const sql = `
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
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `;

    // wallet_id is the partner's wallets row id (the id Partner's ledger writer uses and the
    // FK target in the repository schema). Callers pass a partner_wallets id, which is the
    // same row when wallets is the live view over partner_wallets.
    const walletRes = await this._exec(
      'SELECT id FROM wallets WHERE partner_id = $1 LIMIT 1',
      [partnerId],
      client,
    );
    const ledgerWalletId = (walletRes && walletRes.rows && walletRes.rows[0] && walletRes.rows[0].id) || walletId;

    const values = [
      ledgerWalletId,
      partnerId,
      dbTxType,
      dbDirection,
      numAmount,
      numBalanceBefore,
      numBalanceAfter,
      dbRefType,
      referenceId || null,
      status || 'COMPLETED',
      description,
      JSON.stringify(metadata || {}),
    ];

    const res = await this._exec(sql, values, client);
    return res.rows[0] || null;
  }

  async getPartnerRecentTransactions(partnerId, limit = 10) {
    const sql = `
      SELECT
        id,
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
      FROM wallet_transactions
      WHERE partner_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `;
    const res = await this._exec(sql, [partnerId, limit]);
    return res.rows.map((row) => ({
      id: row.id,
      walletId: row.wallet_id,
      partnerId: row.partner_id,
      transactionType: row.transaction_type,
      direction: String(row.direction).toUpperCase(),
      amount: Number(row.amount),
      balanceBefore: Number(row.balance_before),
      balanceAfter: Number(row.balance_after),
      referenceType: row.reference_type,
      referenceId: row.reference_id,
      status: row.status,
      description: row.description,
      metadata: row.metadata,
      createdAt: row.created_at,
    }));
  }

  async getPartnerPreviousPayouts(partnerId, excludePayoutId = null, limit = 10) {
    const conditions = ['partner_id = $1'];
    const params = [partnerId];
    let pIdx = 2;
    if (excludePayoutId) {
      conditions.push(`id != $${pIdx}`);
      params.push(excludePayoutId);
      pIdx += 1;
    }
    params.push(limit);

    const sql = `
      SELECT
        id,
        partner_id,
        bank_account_id,
        amount,
        status,
        payment_method,
        payment_reference,
        provider_transfer_id,
        failure_reason,
        notes,
        requested_at,
        processed_at,
        completed_at,
        created_at
      FROM payouts
      WHERE ${conditions.join(' AND ')}
      ORDER BY requested_at DESC
      LIMIT $${pIdx}
    `;
    const res = await this._exec(sql, params);
    return res.rows.map((r) => {
      const raw = (r.status || '').toLowerCase();
      let displayStatus = 'PENDING';
      if (raw === 'completed' || raw === 'paid') {
        displayStatus = 'PAID';
      } else if (raw === 'failed' || raw === 'rejected') {
        displayStatus = 'REJECTED';
      } else if (raw === 'cancelled') {
        displayStatus = 'CANCELLED';
      } else if (raw === 'processing') {
        displayStatus = 'PROCESSING';
      } else if (raw === 'approved') {
        displayStatus = 'APPROVED';
      } else {
        displayStatus = 'PENDING';
      }
      return {
        id: r.id,
        amount: Number(r.amount),
        status: displayStatus,
        rawStatus: r.status,
        paymentMethod: r.payment_method,
        paymentReference: r.payment_reference || r.provider_transfer_id,
        failureReason: r.failure_reason,
        notes: r.notes,
        requestedAt: r.requested_at,
        processedAt: r.processed_at || r.completed_at,
        createdAt: r.created_at,
      };
    });
  }

  async updatePayoutStatus(client, payoutId, {
    status,
    providerTransferId,
    failureReason,
    processedAt,
  }) {
    const sql = `
      UPDATE payouts
      SET
        status = $2,
        provider_transfer_id = COALESCE($3, provider_transfer_id),
        failure_reason = COALESCE($4, failure_reason),
        processed_at = COALESCE($5, processed_at),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;

    const params = [
      payoutId,
      status,
      providerTransferId || null,
      failureReason || null,
      processedAt || null,
    ];

    const res = await this._exec(sql, params, client);
    return res.rows[0] || null;
  }

  async getPayoutByIdempotencyKey(partnerId, idempotencyKey) {
    const sql = `
      SELECT * FROM payouts
      WHERE partner_id = $1 AND idempotency_key = $2
      LIMIT 1
    `;
    const res = await this._exec(sql, [partnerId, idempotencyKey]);
    return res.rows[0] || null;
  }

  async getPayoutEvents(payoutId) {
    const sql = `
      SELECT id, aggregate_id, event_type, payload, is_published, created_at
      FROM outbox_events
      WHERE aggregate_id = $1::text OR payload->>'payoutId' = $1::text
      ORDER BY created_at DESC
      LIMIT 50
    `;
    try {
      const res = await this._exec(sql, [payoutId]);
      return res.rows.map((row) => ({
        id: row.id,
        eventType: row.event_type,
        payload: row.payload || {},
        isPublished: row.is_published,
        createdAt: row.created_at,
      }));
    } catch {
      return [];
    }
  }

  async getPayoutReconciliationSummary() {
    const sql = `
      SELECT
        COUNT(*)::int AS total_payouts,
        COUNT(*) FILTER (WHERE status = 'REQUESTED')::int AS requested_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'REQUESTED'), 0.00)::numeric(12,2) AS requested_amount,
        COUNT(*) FILTER (WHERE status = 'PROCESSING')::int AS processing_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'PROCESSING'), 0.00)::numeric(12,2) AS processing_amount,
        COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'COMPLETED'), 0.00)::numeric(12,2) AS completed_amount,
        COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'FAILED'), 0.00)::numeric(12,2) AS failed_amount,
        COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'CANCELLED'), 0.00)::numeric(12,2) AS cancelled_amount
      FROM payouts
    `;

    const res = await this._exec(sql);
    const row = res.rows[0] || {};

    return {
      currency: 'INR',
      totalPayouts: Number(row.total_payouts || 0),
      requested: {
        count: Number(row.requested_count || 0),
        amount: Number(row.requested_amount || 0),
      },
      processing: {
        count: Number(row.processing_count || 0),
        amount: Number(row.processing_amount || 0),
      },
      completed: {
        count: Number(row.completed_count || 0),
        amount: Number(row.completed_amount || 0),
      },
      failed: {
        count: Number(row.failed_count || 0),
        amount: Number(row.failed_amount || 0),
      },
      cancelled: {
        count: Number(row.cancelled_count || 0),
        amount: Number(row.cancelled_amount || 0),
      },
    };
  }

  async getPayoutTransactions(payoutId) {
    const sql = `
      SELECT
        id,
        payout_id,
        attempt_number,
        gateway,
        gateway_payout_id,
        gateway_transaction_id,
        amount,
        currency,
        status,
        failure_code,
        failure_reason,
        created_at,
        updated_at
      FROM payout_transactions
      WHERE payout_id = $1
      ORDER BY attempt_number ASC, created_at ASC
    `;
    try {
      const res = await this._exec(sql, [payoutId]);
      return res.rows.map((r) => ({
        id: r.id,
        payoutId: r.payout_id,
        attemptNumber: r.attempt_number,
        gateway: r.gateway,
        gatewayPayoutId: r.gateway_payout_id,
        gatewayTransactionId: r.gateway_transaction_id,
        amount: Number(r.amount),
        currency: r.currency,
        status: r.status,
        failureCode: r.failure_code,
        failureReason: r.failure_reason,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
    } catch {
      return [];
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // TRANSACTION HELPER
  // ══════════════════════════════════════════════════════════════════════════════

  async executeInTransaction(callback) {
    if (mockWalletResolver) {
      return callback({ query: (sql, p) => this._exec(sql, p) });
    }
    return transaction(callback);
  }
}

module.exports = new AdminWalletRepository();
module.exports.AdminWalletRepository = AdminWalletRepository;
module.exports.setMockWalletResolver = setMockWalletResolver;
module.exports.resetMockWalletResolver = resetMockWalletResolver;
