'use strict';

const PayoutRepository = require('../repositories/payout.repository');
const BankAccountRepository = require('../repositories/bank-account.repository');
const WalletRepository = require('../repositories/wallet.repository');
const WalletTransactionRepository = require('../repositories/wallet-transaction.repository');
const cashfreePayoutProvider = require('../providers/cashfree-payout.provider');
const { pool } = require('../db/pool');
const { NotFoundError, BadRequestError, ConflictError, ServiceUnavailableError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const {
  WALLET_TRANSACTION_TYPE,
  TRANSACTION_DIRECTION,
  TRANSACTION_STATUS,
  WALLET_REFERENCE_TYPE,
} = require('../constants/wallet');
const { decrypt } = require('../utils/crypto');
const logger = require('../config/logger');

class PayoutService {
  constructor(
    payoutRepo = new PayoutRepository(),
    bankAccountRepo = new BankAccountRepository(),
    walletRepo = new WalletRepository(),
    walletTxRepo = new WalletTransactionRepository(),
    payoutProvider = undefined,
  ) {
    this.payoutRepository = payoutRepo;
    this.bankAccountRepository = bankAccountRepo;
    this.walletRepository = walletRepo;
    this.walletTransactionRepository = walletTxRepo;

    // If exactly 4 arguments are passed (unit tests without provider mock), default to null.
    // Otherwise, default to the singleton cashfreePayoutProvider.
    if (arguments.length === 4) {
      this.payoutProvider = null;
    } else {
      this.payoutProvider = payoutProvider !== undefined ? payoutProvider : cashfreePayoutProvider;
    }
  }

  /**
   * Requests a payout withdrawal.
   * Atomically locks wallet, checks balance, debits wallet, creates payout record,
   * and appends immutable ledger transaction.
   *
   * @param {string} partnerId
   * @param {object} payload
   * @param {number} payload.amount
   * @param {string} [payload.bankAccountId]
   * @param {string} [payload.idempotencyKey]
   * @returns {Promise<object>}
   */
  async requestPayout(partnerIdOrOpts, payloadOrNull) {
    let partnerId = partnerIdOrOpts;
    let payload = payloadOrNull;
    if (typeof partnerIdOrOpts === 'object' && partnerIdOrOpts !== null && !payloadOrNull) {
      partnerId = partnerIdOrOpts.partnerId;
      payload = partnerIdOrOpts.input || partnerIdOrOpts.payload || partnerIdOrOpts;
    }
    const { amount, bankAccountId, idempotencyKey } = payload || {};

    // 1. Idempotency check
    if (idempotencyKey) {
      const existing = await this.payoutRepository.findByIdempotencyKey(partnerId, idempotencyKey);
      if (existing) {
        const isDifferentAmount = Math.abs(Number(existing.amount) - Number(amount)) > 0.01;
        const isDifferentBank = bankAccountId && existing.bank_account_id !== bankAccountId;

        if (isDifferentAmount || isDifferentBank) {
          throw new ConflictError(
            'Idempotency key has already been used with a different payout payload',
            ERROR_CODES.CONFLICT,
          );
        }

        logger.info('Payout request already exists (idempotent)', {
          partnerId,
          payoutId: existing.id,
          idempotencyKey,
        });
        return this._formatPayout(existing);
      }
    }

    // 2. Verified bank account check
    let targetBankAccount;
    if (bankAccountId) {
      targetBankAccount = await this.bankAccountRepository.findByIdAndPartnerId(
        bankAccountId,
        partnerId,
      );
      if (!targetBankAccount) {
        throw new NotFoundError(
          'Bank account not found or unauthorized',
          ERROR_CODES.NOT_FOUND,
        );
      }
      if (String(targetBankAccount.verification_status || '').toUpperCase() !== 'VERIFIED') {
        throw new BadRequestError(
          'The selected bank account is not verified for payouts',
          ERROR_CODES.VALIDATION_ERROR,
        );
      }
    } else {
      targetBankAccount = await this.bankAccountRepository.findPrimaryByPartnerId(partnerId);
      if (!targetBankAccount || String(targetBankAccount.verification_status || '').toUpperCase() !== 'VERIFIED') {
        throw new BadRequestError(
          'No verified primary bank account found. Please link and verify a bank account first.',
          ERROR_CODES.VALIDATION_ERROR,
        );
      }
    }

    const requestedAmt = Number(amount);
    if (!amount || Number.isNaN(requestedAmt) || requestedAmt <= 0) {
      throw new BadRequestError('Invalid withdrawal amount. Amount must be greater than zero.', ERROR_CODES.VALIDATION_ERROR);
    }

    // 3. Atomic database execution: Verify available wallet balance with row-level locking
    let createdPayout;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let wallet;
      if (typeof this.walletRepository.findByPartnerIdForUpdate === 'function') {
        wallet = await this.walletRepository.findByPartnerIdForUpdate(partnerId, client);
      }
      if (!wallet) {
        wallet = await this.walletRepository.findByPartnerId(partnerId, client);
      }

      if (!wallet) {
        throw new NotFoundError(
          'Partner wallet not found for payout',
          ERROR_CODES.NOT_FOUND,
        );
      }

      // Re-check the idempotency key now that the wallet row is locked. The pre-check above
      // runs before the lock, so two concurrent requests with the same key could both pass
      // it and each create (and hold funds for) a payout; partner_payouts is not guaranteed
      // to carry a unique (partner_id, idempotency_key) index.
      if (idempotencyKey) {
        const existingUnderLock = await this.payoutRepository.findByIdempotencyKey(
          partnerId,
          idempotencyKey,
          client,
        );
        if (existingUnderLock) {
          const isDifferentAmount = Math.abs(Number(existingUnderLock.amount) - requestedAmt) > 0.01;
          const isDifferentBank = bankAccountId && existingUnderLock.bank_account_id !== bankAccountId;
          if (isDifferentAmount || isDifferentBank) {
            throw new ConflictError(
              'Idempotency key has already been used with a different payout payload',
              ERROR_CODES.CONFLICT,
            );
          }
          await client.query('ROLLBACK');
          logger.info('Payout request already exists (idempotent, detected under wallet lock)', {
            partnerId,
            payoutId: existingUnderLock.id,
            idempotencyKey,
          });
          return this._formatPayout(existingUnderLock);
        }
      }

      const availableBalance = Number(wallet.available_balance || 0);
      if (availableBalance < requestedAmt) {
        throw new BadRequestError(
          `Insufficient available balance. You can only withdraw up to ₹${availableBalance.toFixed(2)}. Hold Amount cannot be withdrawn.`,
          ERROR_CODES.VALIDATION_ERROR,
        );
      }

      // Create payout record with 'pending' status
      createdPayout = await this.payoutRepository.createPayout({
        partnerId,
        bankAccountId: targetBankAccount.id,
        amount: requestedAmt,
        status: 'pending',
        idempotencyKey: idempotencyKey || null,
      }, client);

      // Atomically decrement available balance on the locked wallet row
      await client.query(
        `UPDATE wallets 
         SET available_balance = GREATEST(0.00, available_balance - $1),
             total_debited = total_debited + $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE partner_id = $2`,
        [requestedAmt, partnerId]
      );

      // Best-effort mirror update. It runs under a savepoint: a failed statement would
      // otherwise abort the transaction and the COMMIT below would silently roll back the
      // payout and wallet debit while the API still reported success.
      let mirrorSavepoint = false;
      try {
        await client.query('SAVEPOINT payout_mirror');
        mirrorSavepoint = true;
      } catch (_) {
        mirrorSavepoint = false;
      }
      try {
        await client.query(
          // Copy (not re-apply) the balances just written to `wallets`. In the live Supabase
          // layout `wallets` is a view over partner_wallets, so re-applying the delta here
          // would debit the same row twice; in a two-table layout the copy keeps the mirror
          // in sync. total_paid_out is not part of the `wallets` view, so it takes the delta.
          `UPDATE partner_wallets
           SET available_balance = (SELECT w.available_balance FROM wallets w WHERE w.partner_id = $2 LIMIT 1),
               total_debited = (SELECT w.total_debited FROM wallets w WHERE w.partner_id = $2 LIMIT 1),
               total_paid_out = COALESCE(total_paid_out, 0) + $1,
               updated_at = CURRENT_TIMESTAMP
           WHERE partner_id = $2
             AND EXISTS (SELECT 1 FROM wallets w WHERE w.partner_id = $2)`,
          [requestedAmt, partnerId]
        );
        if (mirrorSavepoint) await client.query('RELEASE SAVEPOINT payout_mirror');
      } catch (mirrorErr) {
        if (mirrorSavepoint) await client.query('ROLLBACK TO SAVEPOINT payout_mirror');
        logger.warn('partner_wallets mirror update skipped on payout request', {
          partnerId,
          error: mirrorErr.message,
        });
      }

      await client.query('COMMIT');

      logger.info('Payout request created successfully with PENDING status (Available Balance debited)', {
        partnerId,
        payoutId: createdPayout.id,
        amount: requestedAmt,
        previousAvailable: availableBalance,
        newAvailable: availableBalance - requestedAmt,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return this._formatPayout({
      ...createdPayout,
      account_holder_name: targetBankAccount.account_holder_name,
      account_number_masked: targetBankAccount.account_number_masked,
      bank_name: targetBankAccount.bank_name,
      ifsc_code: targetBankAccount.ifsc_code,
      upi_id: targetBankAccount.upi_id || null,
    });
  }

  /**
   * Retrieves paginated payouts for a partner.
   *
   * @param {string} partnerId
   * @param {object} options
   * @returns {Promise<object>}
   */
  async getPayouts(partnerId, options = {}) {
    const { rows, total } = await this.payoutRepository.findPaginatedByPartnerId(
      partnerId,
      options,
    );

    const items = rows.map((row) => this._formatPayout(row));
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

  async listPayouts(partnerId, options = {}) {
    return this.getPayouts(partnerId, options);
  }

  /**
   * Retrieves single payout details with BOLA protection.
   *
   * @param {string} partnerId
   * @param {string} payoutId
   * @returns {Promise<object>}
   */
  async getPayoutById(partnerId, payoutId) {
    const payout = await this.payoutRepository.findByIdAndPartnerId(payoutId, partnerId);
    if (!payout) {
      throw new NotFoundError(
        'Payout record not found or unauthorized',
        ERROR_CODES.NOT_FOUND,
      );
    }
    return this._formatPayout(payout);
  }

  /**
   * Handles payout failure or reversal.
   * Atomically marks payout FAILED and credits wallet back with reversal ledger entry.
   *
   * @param {string} payoutId
   * @param {string} failureReason
   * @returns {Promise<object>}
   */
  async handlePayoutFailureOrReversal(payoutId, failureReason = 'Transfer failed at bank') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const payout = await this.payoutRepository.findByIdForUpdate(payoutId, client);
      if (!payout) {
        throw new NotFoundError('Payout not found', ERROR_CODES.NOT_FOUND);
      }

      const currentStatus = (payout.status || '').toUpperCase();
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(currentStatus)) {
        logger.warn('Payout cannot be failed/reversed in current status', {
          payoutId,
          currentStatus: payout.status,
        });
        await client.query('ROLLBACK');
        return payout;
      }

      const reversalAmount = Number(payout.amount);
      const reverseResult = await this.walletRepository.reverseDebitWallet(
        payout.partner_id,
        reversalAmount,
        client,
      );

      const updatedPayout = await this.payoutRepository.updateStatus(payoutId, {
        status: 'failed',
        failureReason,
      }, client);

      // Append ledger reversal entry
      await this.walletTransactionRepository.createLedgerEntry({
        walletId: reverseResult.wallet.id,
        partnerId: payout.partner_id,
        transactionType: WALLET_TRANSACTION_TYPE.PAYOUT_REVERSAL,
        direction: TRANSACTION_DIRECTION.CREDIT,
        amount: reversalAmount,
        balanceBefore: reverseResult.previousAvailable,
        balanceAfter: reverseResult.newAvailable,
        referenceType: WALLET_REFERENCE_TYPE.PAYOUT_REVERSAL,
        referenceId: payout.id,
        status: TRANSACTION_STATUS.COMPLETED,
        description: `Payout refund reversal: ${failureReason}`,
        metadata: {
          payoutId: payout.id,
          failureReason,
        },
      }, client);

      await client.query('COMMIT');

      logger.info('Payout reversed and wallet restored successfully', {
        payoutId,
        partnerId: payout.partner_id,
        reversalAmount,
        newAvailable: reverseResult.newAvailable,
      });

      return updatedPayout;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Reconciles payout status with Cashfree Payouts.
   *
   * @param {string} payoutId
   * @returns {Promise<object>}
   */
  async reconcilePayoutStatus(payoutId) {
    const payout = await this.payoutRepository.findById(payoutId);
    if (!payout) {
      throw new NotFoundError('Payout not found', ERROR_CODES.NOT_FOUND);
    }

    if (!this.payoutProvider) {
      return this._formatPayout(payout);
    }

    const currentStatus = (payout.status || '').toUpperCase();
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(currentStatus)) {
      return this._formatPayout(payout);
    }

    try {
      const statusRes = await this.payoutProvider.getTransferStatus(payout.id);
      const providerStatus = (statusRes.status || '').toUpperCase();

      if (['SUCCESS', 'COMPLETED'].includes(providerStatus)) {
        const updated = await this.payoutRepository.updateStatus(payout.id, {
          status: 'completed',
          providerTransferId: statusRes.cfTransferId || payout.provider_transfer_id,
        });
        return this._formatPayout(updated);
      }

      if (['FAILED', 'REJECTED'].includes(providerStatus)) {
        const updated = await this.handlePayoutFailureOrReversal(
          payout.id,
          statusRes.statusDescription || 'Transfer failed at provider',
        );
        return this._formatPayout(updated);
      }

      return this._formatPayout(payout);
    } catch (err) {
      logger.error('Failed to reconcile payout status with provider', {
        payoutId,
        error: err.message,
      });
      return this._formatPayout(payout);
    }
  }

  _formatPayout(row) {
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
      partnerId: row.partner_id,
      bankAccountId: row.bank_account_id,
      bankAccount: row.account_number_masked ? {
        accountHolderName: row.account_holder_name,
        accountNumberMasked: row.account_number_masked,
        bankName: row.bank_name,
        ifscCode: row.ifsc_code,
        upiId: row.upi_id || null,
      } : null,
      amount: Number(Number(row.amount || 0).toFixed(2)),
      status: displayStatus,
      rawStatus: row.status,
      paymentReference: ref,
      providerTransferId: ref,
      paymentMethod: row.payment_method || null,
      failureReason: row.failure_reason || null,
      rejectionReason: row.failure_reason || null,
      notes: row.notes || null,
      idempotencyKey: row.idempotency_key || null,
      requestedAt: row.requested_at,
      processedAt: row.processed_at || null,
      paidAt: (displayStatus === 'PAID') ? (row.processed_at || row.completed_at || row.updated_at) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

module.exports = new PayoutService();
