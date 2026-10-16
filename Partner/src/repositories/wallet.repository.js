'use strict';

const BaseRepository = require('../db/base.repository');

class WalletRepository extends BaseRepository {
  constructor() {
    super('wallets', 'id');
  }

  /**
   * Find wallet by partner ID.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findByPartnerId(partnerId, client = null) {
    const text = `
      SELECT id, partner_id, available_balance, pending_balance, total_credited, total_debited, currency, created_at, updated_at
      FROM ${this.tableName}
      WHERE partner_id = $1
      LIMIT 1
    `;
    const res = client
      ? await client.query(text, [partnerId])
      : await this.query(text, [partnerId]);
    return res.rows[0] || null;
  }

  /**
   * Find wallet by partner ID with row-level exclusive lock (FOR UPDATE).
   * MUST be called within an active transaction.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object|null>}
   */
  async findByPartnerIdForUpdate(partnerId, client) {
    if (!client) {
      throw new Error('findByPartnerIdForUpdate requires an active database transaction client');
    }
    const text = `
      SELECT id, partner_id, available_balance, pending_balance, total_credited, total_debited, currency, created_at, updated_at
      FROM ${this.tableName}
      WHERE partner_id = $1
      FOR UPDATE
    `;
    const res = await client.query(text, [partnerId]);
    return res.rows[0] || null;
  }

  /**
   * Initialize a default zero-balance partner wallet within an existing client/transaction.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object>}
   */
  async createWallet(partnerId, client) {
    const text = `
      INSERT INTO ${this.tableName} (
        partner_id, available_balance, pending_balance
      )
      VALUES ($1, 0.00, 0.00)
      RETURNING id, partner_id, available_balance, pending_balance, created_at, updated_at
    `;
    const res = await client.query(text, [partnerId]);
    return res.rows[0];
  }

  /**
   * Updates wallet balances atomically within a transaction.
   *
   * @param {string} walletId
   * @param {object} balances
   * @param {number} balances.availableBalance
   * @param {number} balances.totalCredited
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object>}
   */
  async updateBalances(walletId, { availableBalance, totalCredited }, client) {
    if (!client) {
      throw new Error('updateBalances requires an active database transaction client');
    }
    if (availableBalance < 0 || totalCredited < 0) {
      throw new Error('Wallet balances cannot be negative');
    }
    const text = `
      UPDATE ${this.tableName}
      SET available_balance = $1,
          total_credited = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING id, partner_id, available_balance, pending_balance, total_credited, total_debited, currency, created_at, updated_at
    `;
    const res = await client.query(text, [availableBalance, totalCredited, walletId]);
    return res.rows[0];
  }

  /**
   * Atomically credits a partner's wallet inside an active database transaction.
   * Locks the wallet row, validates amounts, calculates new balances server-side,
   * and updates available_balance and total_credited.
   *
   * @param {string} partnerId
   * @param {number} amount
   * @param {import('pg').PoolClient} client
   * @returns {Promise<{ wallet: object, previousAvailable: number,
   *   newAvailable: number, creditAmount: number }|null>}
   */
  async creditWallet(partnerId, amount, client) {
    if (!client) {
      throw new Error('creditWallet requires an active database transaction client');
    }
    const creditAmount = Number(amount);
    if (Number.isNaN(creditAmount) || creditAmount <= 0) {
      throw new Error('Credit amount must be a positive number');
    }

    const wallet = await this.findByPartnerIdForUpdate(partnerId, client);
    if (!wallet) {
      return null;
    }

    const previousAvailable = Number(wallet.available_balance || 0);
    const previousTotalCredited = Number(wallet.total_credited || 0);
    const newAvailable = Number((previousAvailable + creditAmount).toFixed(2));
    const newTotalCredited = Number((previousTotalCredited + creditAmount).toFixed(2));

    const updated = await this.updateBalances(wallet.id, {
      availableBalance: newAvailable,
      totalCredited: newTotalCredited,
    }, client);

    return {
      wallet: updated,
      previousAvailable,
      newAvailable,
      creditAmount,
    };
  }

  /**
   * Atomically debits a partner's wallet inside an active database transaction.
   * Locks the wallet row, checks available balance, calculates new balance server-side,
   * and updates available_balance and total_debited.
   *
   * @param {string} partnerId
   * @param {number} amount
   * @param {import('pg').PoolClient} client
   * @returns {Promise<{ insufficientBalance: boolean, wallet: object,
   *   previousAvailable: number, newAvailable?: number, debitAmount?: number }|null>}
   */
  async debitWallet(partnerId, amount, client) {
    if (!client) {
      throw new Error('debitWallet requires an active database transaction client');
    }
    const debitAmount = Number(amount);
    if (Number.isNaN(debitAmount) || debitAmount <= 0) {
      throw new Error('Debit amount must be a positive number');
    }

    const wallet = await this.findByPartnerIdForUpdate(partnerId, client);
    if (!wallet) {
      return null;
    }

    const previousAvailable = Number(wallet.available_balance || 0);
    const previousTotalDebited = Number(wallet.total_debited || 0);

    if (previousAvailable < debitAmount) {
      return {
        insufficientBalance: true,
        wallet,
        previousAvailable,
      };
    }

    const newAvailable = Number((previousAvailable - debitAmount).toFixed(2));
    const newTotalDebited = Number((previousTotalDebited + debitAmount).toFixed(2));

    const text = `
      UPDATE ${this.tableName}
      SET available_balance = $1,
          total_debited = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING id, partner_id, available_balance, pending_balance, total_credited, total_debited, currency, created_at, updated_at
    `;
    const res = await client.query(text, [newAvailable, newTotalDebited, wallet.id]);

    return {
      insufficientBalance: false,
      wallet: res.rows[0],
      previousAvailable,
      newAvailable,
      debitAmount,
    };
  }

  /**
   * Reverses a previous debit (e.g. for failed payout) inside an active database transaction.
   *
   * @param {string} partnerId
   * @param {number} amount
   * @param {import('pg').PoolClient} client
   * @returns {Promise<{ wallet: object, newAvailable: number }|null>}
   */
  async reverseDebitWallet(partnerId, amount, client) {
    if (!client) {
      throw new Error('reverseDebitWallet requires an active database transaction client');
    }
    const reverseAmount = Number(amount);
    if (Number.isNaN(reverseAmount) || reverseAmount <= 0) {
      throw new Error('Reverse amount must be a positive number');
    }

    const wallet = await this.findByPartnerIdForUpdate(partnerId, client);
    if (!wallet) {
      return null;
    }

    const previousAvailable = Number(wallet.available_balance || 0);
    const previousTotalDebited = Number(wallet.total_debited || 0);

    const newAvailable = Number((previousAvailable + reverseAmount).toFixed(2));
    const newTotalDebited = Math.max(0, Number((previousTotalDebited - reverseAmount).toFixed(2)));

    const text = `
      UPDATE ${this.tableName}
      SET available_balance = $1,
          total_debited = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING id, partner_id, available_balance, pending_balance, total_credited, total_debited, currency, created_at, updated_at
    `;
    const res = await client.query(text, [newAvailable, newTotalDebited, wallet.id]);

    return {
      wallet: res.rows[0],
      previousAvailable,
      newAvailable,
      reverseAmount,
    };
  }
}

module.exports = WalletRepository;
