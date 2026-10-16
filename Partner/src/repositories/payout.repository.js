'use strict';

const BaseRepository = require('../db/base.repository');

class PayoutRepository extends BaseRepository {
  constructor() {
    super('partner_payouts', 'id');
  }

  /**
   * Create new payout record.
   *
   * @param {object} payoutData
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object>}
   */
  async createPayout(payoutData, client) {
    const {
      partnerId,
      bankAccountId,
      amount,
      status = 'requested',
      idempotencyKey = null,
      providerTransferId = null,
    } = payoutData;

    const dbStatus = (status || 'requested').toLowerCase();

    const sql = `
      INSERT INTO ${this.tableName} (
        partner_id, bank_account_id, amount, status,
        idempotency_key, provider_transfer_id, requested_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
      RETURNING *;
    `;

    const params = [
      partnerId,
      bankAccountId,
      amount,
      dbStatus,
      idempotencyKey,
      providerTransferId,
    ];

    const res = await client.query(sql, params);
    return res.rows[0];
  }

  /**
   * Find payout by idempotency key for a partner.
   *
   * @param {string} partnerId
   * @param {string} idempotencyKey
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findByIdempotencyKey(partnerId, idempotencyKey, client = null) {
    if (!idempotencyKey) return null;

    const sql = `
      SELECT
        p.id, p.partner_id, p.bank_account_id, p.amount, p.status,
        p.provider_transfer_id, p.failure_reason, p.idempotency_key,
        p.requested_at, p.processed_at, p.created_at, p.updated_at,
        b.account_holder_name, b.account_number_masked, b.bank_name, b.ifsc_code
      FROM ${this.tableName} p
      LEFT JOIN partner_bank_accounts b ON b.id = p.bank_account_id
      WHERE p.partner_id = $1 AND p.idempotency_key = $2
      LIMIT 1;
    `;

    const res = client
      ? await client.query(sql, [partnerId, idempotencyKey])
      : await this.query(sql, [partnerId, idempotencyKey]);

    return res.rows[0] || null;
  }

  /**
   * Find paginated payouts for an authenticated partner.
   *
   * @param {string} partnerId
   * @param {object} [options={}]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ rows: Array<object>, total: number }>}
   */
  async findPaginatedByPartnerId(partnerId, options = {}, client = null) {
    const {
      limit = 20,
      offset = 0,
      status,
    } = options;

    const whereClauses = ['p.partner_id = $1'];
    const queryParams = [partnerId];
    let paramIndex = 2;

    if (status) {
      whereClauses.push(`p.status = $${paramIndex}`);
      queryParams.push(status.toLowerCase());
      paramIndex += 1;
    }

    const whereSql = whereClauses.join(' AND ');

    // 1. Total count query
    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM ${this.tableName} p
      WHERE ${whereSql};
    `;
    const countRes = client
      ? await client.query(countSql, queryParams)
      : await this.query(countSql, queryParams);
    const total = Number(countRes.rows[0]?.total || 0);

    // 2. Data rows query
    const dataSql = `
      SELECT
        p.id, p.partner_id, p.bank_account_id, p.amount, p.status,
        p.provider_transfer_id, p.payment_reference, p.payment_method, p.notes,
        p.processed_by, p.failure_reason, p.idempotency_key,
        p.requested_at, p.processed_at, p.completed_at, p.created_at, p.updated_at,
        b.account_holder_name, b.account_number_masked, b.bank_name, b.ifsc_code, b.upi_id
      FROM ${this.tableName} p
      LEFT JOIN partner_bank_accounts b ON b.id = p.bank_account_id
      WHERE ${whereSql}
      ORDER BY p.requested_at DESC, p.id DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1};
    `;

    const dataParams = [...queryParams, limit, offset];
    const dataRes = client
      ? await client.query(dataSql, dataParams)
      : await this.query(dataSql, dataParams);

    return {
      rows: dataRes.rows,
      total,
    };
  }

  /**
   * Find single payout by ID and partner ID (BOLA protection).
   *
   * @param {string} id
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findByIdAndPartnerId(id, partnerId, client = null) {
    const sql = `
      SELECT
        p.id, p.partner_id, p.bank_account_id, p.amount, p.status,
        p.provider_transfer_id, p.payment_reference, p.payment_method, p.notes,
        p.processed_by, p.failure_reason, p.idempotency_key,
        p.requested_at, p.processed_at, p.completed_at, p.created_at, p.updated_at,
        b.account_holder_name, b.account_number_masked, b.bank_name, b.ifsc_code, b.upi_id
      FROM ${this.tableName} p
      LEFT JOIN partner_bank_accounts b ON b.id = p.bank_account_id
      WHERE p.id = $1 AND p.partner_id = $2
      LIMIT 1;
    `;

    const res = client
      ? await client.query(sql, [id, partnerId])
      : await this.query(sql, [id, partnerId]);

    return res.rows[0] || null;
  }

  /**
   * Find payout record and acquire row-level lock (FOR UPDATE).
   *
   * @param {string} id
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object|null>}
   */
  async findByIdForUpdate(id, client) {
    const sql = `
      SELECT *
      FROM ${this.tableName}
      WHERE id = $1
      FOR UPDATE;
    `;
    const res = await client.query(sql, [id]);
    return res.rows[0] || null;
  }

  /**
   * Find payout record by provider transfer ID or reference/idempotency ID
   * and acquire row-level lock.
   *
   * @param {object} params
   * @param {string} [params.providerTransferId]
   * @param {string} [params.referenceId]
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object|null>}
   */
  async findByTransferOrReferenceIdForUpdate({ providerTransferId, referenceId }, client) {
    const clauses = [];
    const params = [];
    let idx = 1;

    if (providerTransferId) {
      clauses.push(`provider_transfer_id = $${idx}`);
      params.push(providerTransferId);
      idx += 1;
    }

    if (referenceId) {
      clauses.push(`(id::text = $${idx} OR idempotency_key = $${idx})`);
      params.push(referenceId);
      idx += 1;
    }

    if (clauses.length === 0) {
      return null;
    }

    const sql = `
      SELECT *
      FROM ${this.tableName}
      WHERE ${clauses.join(' OR ')}
      LIMIT 1
      FOR UPDATE;
    `;

    const res = await client.query(sql, params);
    return res.rows[0] || null;
  }

  /**
   * Update payout status and resolution metadata.
   *
   * @param {string} id
   * @param {object} updateData
   * @param {string} updateData.status
   * @param {string} [updateData.providerTransferId]
   * @param {string} [updateData.failureReason]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async updateStatus(id, updateData, client = null) {
    const {
      status,
      providerTransferId = null,
      failureReason = null,
    } = updateData;

    const dbStatus = status ? status.toLowerCase() : status;

    const sql = `
      UPDATE ${this.tableName}
      SET
        status = $1,
        provider_transfer_id = COALESCE($2, provider_transfer_id),
        failure_reason = COALESCE($3, failure_reason),
        processed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING *;
    `;

    const res = client
      ? await client.query(sql, [dbStatus, providerTransferId, failureReason, id])
      : await this.query(sql, [dbStatus, providerTransferId, failureReason, id]);
    return res.rows[0];
  }

  /**
   * Find paginated payouts across all partners (Admin view).
   *
   * @param {object} [options={}]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ rows: Array<object>, total: number }>}
   */
  async findPaginatedAdmin(options = {}, client = null) {
    const {
      limit = 20,
      offset = 0,
      status,
      partnerId,
    } = options;

    const whereClauses = [];
    const queryParams = [];
    let paramIndex = 1;

    if (partnerId) {
      whereClauses.push(`p.partner_id = $${paramIndex}`);
      queryParams.push(partnerId);
      paramIndex += 1;
    }

    if (status) {
      whereClauses.push(`p.status = $${paramIndex}`);
      queryParams.push(status.toLowerCase());
      paramIndex += 1;
    }

    const whereSql = whereClauses.length > 0
      ? `WHERE ${whereClauses.join(' AND ')}`
      : '';

    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM ${this.tableName} p
      ${whereSql};
    `;
    const countRes = client
      ? await client.query(countSql, queryParams)
      : await this.query(countSql, queryParams);
    const total = Number(countRes.rows[0]?.total || 0);

    const dataSql = `
      SELECT
        p.id, p.partner_id, p.bank_account_id, p.amount, p.status,
        p.provider_transfer_id, p.failure_reason, p.idempotency_key,
        p.requested_at, p.processed_at, p.created_at, p.updated_at,
        b.account_holder_name, b.account_number_masked, b.bank_name, b.ifsc_code,
        pr.business_name AS partner_name
      FROM ${this.tableName} p
      LEFT JOIN partner_bank_accounts b ON b.id = p.bank_account_id
      LEFT JOIN partners pr ON pr.id = p.partner_id
      ${whereSql}
      ORDER BY p.requested_at DESC, p.id DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1};
    `;

    const dataParams = [...queryParams, limit, offset];
    const dataRes = client
      ? await client.query(dataSql, dataParams)
      : await this.query(dataSql, dataParams);

    return {
      rows: dataRes.rows,
      total,
    };
  }

  /**
   * Find single payout details for Admin.
   *
   * @param {string} id
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findByIdAdmin(id, client = null) {
    const sql = `
      SELECT
        p.id, p.partner_id, p.bank_account_id, p.amount, p.status,
        p.provider_transfer_id, p.failure_reason, p.idempotency_key,
        p.requested_at, p.processed_at, p.created_at, p.updated_at,
        b.account_holder_name, b.account_number_masked, b.bank_name, b.ifsc_code,
        pr.business_name AS partner_name
      FROM ${this.tableName} p
      LEFT JOIN partner_bank_accounts b ON b.id = p.bank_account_id
      LEFT JOIN partners pr ON pr.id = p.partner_id
      WHERE p.id = $1
      LIMIT 1;
    `;

    const res = client
      ? await client.query(sql, [id])
      : await this.query(sql, [id]);

    return res.rows[0] || null;
  }
}

module.exports = PayoutRepository;
