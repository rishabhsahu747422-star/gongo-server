'use strict';

const BaseRepository = require('../db/base.repository');
const {
  toStorageDirection,
  toStorageType,
  toStorageReference,
  ledgerMatchValues,
} = require('../constants/wallet');

/**
 * Appends `LOWER(column) IN ($n, ...)` for the accepted stored values of a domain value.
 *
 * @returns {number} next free parameter index
 */
function pushLedgerMatch(clauses, params, column, values, startIndex) {
  const placeholders = values.map((_, i) => `$${startIndex + i}`);
  clauses.push(`LOWER(${column}) IN (${placeholders.join(', ')})`);
  params.push(...values);
  return startIndex + values.length;
}

/**
 * WalletTransactionRepository — Immutable financial ledger data access layer.
 *
 * FINANCIAL INTEGRITY & IMMUTABILITY:
 *   Every record represents an append-only audit trail entry.
 *   This repository explicitly omits update and delete methods.
 */
class WalletTransactionRepository extends BaseRepository {
  constructor() {
    super('wallet_transactions', 'id');
  }

  /**
   * Create an immutable wallet transaction ledger record within an active transaction.
   *
   * @param {object} params
   * @param {string} params.walletId
   * @param {string} params.partnerId
   * @param {string} params.transactionType
   * @param {string} params.direction - 'CREDIT' | 'DEBIT'
   * @param {number} params.amount
   * @param {number} params.balanceAfter
   * @param {string} params.referenceType
   * @param {string} params.referenceId
   * @param {string} [params.status='COMPLETED']
   * @param {string} [params.description]
   * @param {object} [params.metadata]
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object>}
   */
  async createLedgerEntry({
    walletId,
    partnerId,
    transactionType,
    direction,
    amount,
    balanceBefore = null,
    balanceAfter,
    referenceType,
    referenceId,
    status = 'COMPLETED',
    description = null,
    metadata = {},
  }, client) {
    if (!client) {
      throw new Error('createLedgerEntry requires an active database transaction client');
    }

    const computedBalanceBefore = balanceBefore !== null && balanceBefore !== undefined
      ? balanceBefore
      : (direction === 'DEBIT'
        ? Number(balanceAfter) + Number(amount)
        : Number(balanceAfter) - Number(amount));

    // Storage vocabulary (see constants/wallet.js). Throws on anything but CREDIT/DEBIT.
    const dbDirection = toStorageDirection(direction);
    const dbTransactionType = toStorageType(transactionType) || 'other';
    const dbReferenceType = toStorageReference(referenceType);

    const text = `
      INSERT INTO ${this.tableName} (
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
      RETURNING
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
        created_at;
    `;

    const values = [
      walletId,
      partnerId,
      dbTransactionType,
      dbDirection,
      amount,
      computedBalanceBefore,
      balanceAfter,
      dbReferenceType,
      referenceId,
      status,
      description,
      JSON.stringify(metadata || {}),
    ];

    const res = await client.query(text, values);
    return res.rows[0];
  }

  /**
   * Look up an existing transaction by reference for idempotency checks.
   *
   * @param {object} params
   * @param {string} params.referenceType
   * @param {string} params.referenceId
   * @param {string} [params.direction]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findByReference({ referenceType, referenceId, direction = null, client = null }) {
    let text = `
      SELECT
        id,
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
        metadata,
        created_at
      FROM ${this.tableName}
      WHERE reference_id = $1
    `;
    // Match stored rows ('booking'/'credit') and legacy as-named rows alike, so this
    // idempotency barrier actually finds the entry createLedgerEntry wrote.
    const clauses = [];
    const params = [referenceId];
    let next = pushLedgerMatch(clauses, params, 'reference_type', ledgerMatchValues('reference', referenceType), 2);
    if (direction) {
      next = pushLedgerMatch(clauses, params, 'direction', ledgerMatchValues('direction', direction), next);
    }
    text += ` AND ${clauses.join(' AND ')}`;

    text += ' ORDER BY created_at DESC LIMIT 1;';

    const res = client
      ? await client.query(text, params)
      : await this.query(text, params);

    return res.rows[0] || null;
  }

  /**
   * Finds paginated transactions for a specific partner with optional filters.
   *
   * @param {string} partnerId
   * @param {object} [options={}]
   * @param {number} [options.limit=20]
   * @param {number} [options.offset=0]
   * @param {string} [options.direction]
   * @param {string} [options.type]
   * @param {string} [options.startDate]
   * @param {string} [options.endDate]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ rows: Array<object>, total: number }>}
   */
  async findPaginatedByPartnerId(partnerId, options = {}, client = null) {
    const {
      limit = 20,
      offset = 0,
      direction,
      type,
      startDate,
      endDate,
    } = options;

    const whereClauses = ['partner_id = $1'];
    const queryParams = [partnerId];
    let paramIndex = 2;

    if (direction) {
      paramIndex = pushLedgerMatch(whereClauses, queryParams, 'direction', ledgerMatchValues('direction', direction), paramIndex);
    }

    if (type) {
      paramIndex = pushLedgerMatch(whereClauses, queryParams, 'transaction_type', ledgerMatchValues('type', type), paramIndex);
    }

    if (startDate) {
      whereClauses.push(`created_at >= $${paramIndex}`);
      queryParams.push(startDate);
      paramIndex += 1;
    }

    if (endDate) {
      whereClauses.push(`created_at <= $${paramIndex}`);
      queryParams.push(endDate);
      paramIndex += 1;
    }

    const whereSql = whereClauses.join(' AND ');

    // Optimized single-query pagination with COUNT(*) OVER()
    const dataSql = `
      SELECT
        id,
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
        metadata,
        created_at,
        COUNT(*) OVER()::int AS total_count
      FROM ${this.tableName}
      WHERE ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1};
    `;

    const dataParams = [...queryParams, limit, offset];
    const dataRes = client
      ? await client.query(dataSql, dataParams)
      : await this.query(dataSql, dataParams);

    let total = 0;
    if (dataRes.rows.length > 0) {
      total = Number(dataRes.rows[0].total_count);
    } else if (offset > 0) {
      // Fallback count query only if offset was past end of records
      const countSql = `SELECT COUNT(*)::int AS total FROM ${this.tableName} WHERE ${whereSql};`;
      const countRes = client
        ? await client.query(countSql, queryParams)
        : await this.query(countSql, queryParams);
      total = Number(countRes.rows[0]?.total || 0);
    }

    return {
      rows: dataRes.rows,
      total,
    };
  }

  /**
   * Find a transaction by ID and partner ID (Strict BOLA check).
   *
   * @param {string} transactionId
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findByIdAndPartnerId(transactionId, partnerId, client = null) {
    const text = `
      SELECT
        id,
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
        metadata,
        created_at
      FROM ${this.tableName}
      WHERE id = $1 AND partner_id = $2
      LIMIT 1;
    `;
    const res = client
      ? await client.query(text, [transactionId, partnerId])
      : await this.query(text, [transactionId, partnerId]);

    return res.rows[0] || null;
  }
}

module.exports = WalletTransactionRepository;
