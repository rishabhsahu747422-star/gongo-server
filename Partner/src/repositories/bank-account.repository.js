'use strict';

const BaseRepository = require('../db/base.repository');

class BankAccountRepository extends BaseRepository {
  constructor() {
    super('partner_bank_accounts', 'id');
  }

  /**
   * Create new partner bank account.
   *
   * @param {object} accountData
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async createBankAccount(accountData, client = null) {
    const {
      partnerId,
      accountHolderName,
      accountNumberMasked,
      accountNumberEncrypted,
      ifscCode,
      bankName,
      isPrimary = true,
      verificationStatus = 'PENDING',
    } = accountData;

    const sql = `
      INSERT INTO ${this.tableName} (
        partner_id, account_holder_name, account_number_masked,
        account_number_encrypted, ifsc_code, bank_name,
        is_primary, verification_status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;
    `;

    const params = [
      partnerId,
      accountHolderName,
      accountNumberMasked,
      accountNumberEncrypted,
      ifscCode,
      bankName,
      isPrimary,
      verificationStatus,
    ];

    const res = client
      ? await client.query(sql, params)
      : await this.query(sql, params);

    return res.rows[0];
  }

  /**
   * Find all bank accounts for a partner.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<Array<object>>}
   */
  async findByPartnerId(partnerId, client = null) {
    const sql = `
      SELECT
        id, partner_id, account_holder_name, account_number_masked,
        ifsc_code, bank_name, is_primary, verification_status,
        created_at, updated_at
      FROM ${this.tableName}
      WHERE partner_id = $1
      ORDER BY is_primary DESC, created_at DESC;
    `;

    const res = client
      ? await client.query(sql, [partnerId])
      : await this.query(sql, [partnerId]);

    return res.rows;
  }

  /**
   * Find a specific bank account by ID and partner ID (BOLA protection).
   *
   * @param {string} id
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findByIdAndPartnerId(id, partnerId, client = null) {
    const sql = `
      SELECT
        id, partner_id, account_holder_name, account_number_masked,
        account_number_encrypted, ifsc_code, bank_name,
        is_primary, verification_status, created_at, updated_at
      FROM ${this.tableName}
      WHERE id = $1 AND partner_id = $2
      LIMIT 1;
    `;

    const res = client
      ? await client.query(sql, [id, partnerId])
      : await this.query(sql, [id, partnerId]);

    return res.rows[0] || null;
  }

  /**
   * Find primary bank account for a partner.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findPrimaryByPartnerId(partnerId, client = null) {
    const sql = `
      SELECT
        id, partner_id, account_holder_name, account_number_masked,
        ifsc_code, bank_name, is_primary, verification_status,
        created_at, updated_at
      FROM ${this.tableName}
      WHERE partner_id = $1 AND is_primary = true
      LIMIT 1;
    `;

    try {
      const res = client
        ? await client.query(sql, [partnerId])
        : await this.query(sql, [partnerId]);

      return res.rows[0] || null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Unset primary status for all accounts belonging to a partner.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<void>}
   */
  async unsetPrimary(partnerId, client = null) {
    const sql = `
      UPDATE ${this.tableName}
      SET is_primary = false, updated_at = CURRENT_TIMESTAMP
      WHERE partner_id = $1;
    `;

    if (client) {
      await client.query(sql, [partnerId]);
    } else {
      await this.query(sql, [partnerId]);
    }
  }

  /**
   * Set specific account as primary for partner.
   *
   * @param {string} id
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async setPrimary(id, partnerId, client = null) {
    await this.unsetPrimary(partnerId, client);

    const sql = `
      UPDATE ${this.tableName}
      SET is_primary = true, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND partner_id = $2
      RETURNING *;
    `;

    const res = client
      ? await client.query(sql, [id, partnerId])
      : await this.query(sql, [id, partnerId]);

    return res.rows[0] || null;
  }

  /**
   * Check if bank account has active payouts (REQUESTED or PROCESSING).
   *
   * @param {string} bankAccountId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<boolean>}
   */
  async hasActivePayouts(bankAccountId, client = null) {
    const sql = `
      SELECT 1
      FROM payouts
      WHERE bank_account_id = $1 AND status IN ('REQUESTED', 'PROCESSING')
      LIMIT 1;
    `;

    const res = client
      ? await client.query(sql, [bankAccountId])
      : await this.query(sql, [bankAccountId]);

    return res.rows.length > 0;
  }

  /**
   * Delete bank account by ID and partner ID.
   *
   * @param {string} id
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<boolean>}
   */
  async deleteByIdAndPartnerId(id, partnerId, client = null) {
    const sql = `
      DELETE FROM ${this.tableName}
      WHERE id = $1 AND partner_id = $2
      RETURNING id;
    `;

    const res = client
      ? await client.query(sql, [id, partnerId])
      : await this.query(sql, [id, partnerId]);

    return res.rows.length > 0;
  }
}

module.exports = BankAccountRepository;
