'use strict';

const BankAccountRepository = require('../repositories/bank-account.repository');
const { maskBankAccountNumber } = require('../utils/mask');
const { encrypt } = require('../utils/crypto');
const { NotFoundError, ConflictError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const { pool } = require('../db/pool');

class BankAccountService {
  constructor(bankAccountRepo = new BankAccountRepository()) {
    this.bankAccountRepository = bankAccountRepo;
  }

  /**
   * Adds a new bank account for the partner.
   *
   * @param {string} partnerId
   * @param {object} payload
   * @param {string} payload.accountHolderName
   * @param {string} payload.accountNumber
   * @param {string} payload.ifscCode
   * @param {string} payload.bankName
   * @param {boolean} [payload.isPrimary=true]
   * @returns {Promise<object>}
   */
  async addBankAccount(partnerId, payload) {
    const {
      accountHolderName,
      accountNumber,
      ifscCode,
      bankName,
      isPrimary = true,
    } = payload;

    const accountNumberMasked = maskBankAccountNumber(accountNumber);
    const accountNumberEncrypted = encrypt(accountNumber);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const existingAccounts = await this.bankAccountRepository.findByPartnerId(partnerId, client);
      const shouldBePrimary = isPrimary || existingAccounts.length === 0;

      if (shouldBePrimary && existingAccounts.length > 0) {
        await this.bankAccountRepository.unsetPrimary(partnerId, client);
      }

      const created = await this.bankAccountRepository.createBankAccount({
        partnerId,
        accountHolderName,
        accountNumberMasked,
        accountNumberEncrypted,
        ifscCode,
        bankName,
        isPrimary: shouldBePrimary,
        verificationStatus: 'VERIFIED', // Sandbox/Mock auto-verification
      }, client);

      await client.query('COMMIT');

      return {
        id: created.id,
        partnerId: created.partner_id,
        accountHolderName: created.account_holder_name,
        accountNumberMasked: created.account_number_masked,
        ifscCode: created.ifsc_code,
        bankName: created.bank_name,
        isPrimary: created.is_primary,
        verificationStatus: created.verification_status,
        createdAt: created.created_at,
        updatedAt: created.updated_at,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Retrieves all bank accounts for the partner.
   *
   * @param {string} partnerId
   * @returns {Promise<Array<object>>}
   */
  async getBankAccounts(partnerId) {
    const accounts = await this.bankAccountRepository.findByPartnerId(partnerId);

    return accounts.map((acc) => ({
      id: acc.id,
      partnerId: acc.partner_id,
      accountHolderName: acc.account_holder_name,
      accountNumberMasked: acc.account_number_masked,
      ifscCode: acc.ifsc_code,
      bankName: acc.bank_name,
      isPrimary: acc.is_primary,
      verificationStatus: acc.verification_status,
      createdAt: acc.created_at,
      updatedAt: acc.updated_at,
    }));
  }

  /**
   * Retrieves single bank account for the partner.
   *
   * @param {string} partnerId
   * @param {string} bankAccountId
   * @returns {Promise<object>}
   */
  async getBankAccountById(partnerId, bankAccountId) {
    const account = await this.bankAccountRepository.findByIdAndPartnerId(bankAccountId, partnerId);

    if (!account) {
      throw new NotFoundError(
        'Bank account not found or unauthorized',
        ERROR_CODES.NOT_FOUND,
      );
    }

    return {
      id: account.id,
      partnerId: account.partner_id,
      accountHolderName: account.account_holder_name,
      accountNumberMasked: account.account_number_masked,
      ifscCode: account.ifsc_code,
      bankName: account.bank_name,
      isPrimary: account.is_primary,
      verificationStatus: account.verification_status,
      createdAt: account.created_at,
      updatedAt: account.updated_at,
    };
  }

  /**
   * Deletes a bank account. Enforces BOLA and blocks deletion if active payouts exist.
   *
   * @param {string} partnerId
   * @param {string} bankAccountId
   * @returns {Promise<{ deleted: boolean }>}
   */
  async deleteBankAccount(partnerId, bankAccountId) {
    const account = await this.bankAccountRepository.findByIdAndPartnerId(bankAccountId, partnerId);
    if (!account) {
      throw new NotFoundError(
        'Bank account not found or unauthorized',
        ERROR_CODES.NOT_FOUND,
      );
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const hasActive = await this.bankAccountRepository.hasActivePayouts(bankAccountId, client);
      if (hasActive) {
        throw new ConflictError(
          'Cannot delete bank account with active payouts pending or processing',
          ERROR_CODES.CONFLICT,
        );
      }

      await this.bankAccountRepository.deleteByIdAndPartnerId(bankAccountId, partnerId, client);

      // If deleted account was primary, elect another account as primary if any exist
      if (account.is_primary) {
        const remaining = await this.bankAccountRepository.findByPartnerId(partnerId, client);
        if (remaining.length > 0) {
          await this.bankAccountRepository.setPrimary(remaining[0].id, partnerId, client);
        }
      }

      await client.query('COMMIT');
      return { deleted: true };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = new BankAccountService();
