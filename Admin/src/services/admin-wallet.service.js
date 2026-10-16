'use strict';

const adminWalletRepository = require('../repositories/admin-wallet.repository');
const cashfreeProvider = require('../providers/cashfree');
const auditService = require('./audit.service');
const { resolveFinancialActorId } = require('../security/financial-actor');
const {
  BadRequestError,
  NotFoundError,
  ConflictError,
} = require('../errors');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(value, fieldName = 'id') {
  if (!value || typeof value !== 'string' || !UUID_REGEX.test(value.trim())) {
    throw new BadRequestError(`Invalid ${fieldName}: must be a valid UUID`);
  }
}

/**
 * Resolves the acting admin's users.id for processed_by. Never substitutes another
 * admin; refuses the action if the actor cannot be resolved (see security/financial-actor).
 */
const resolveAdminUserUuid = (client, adminUser) => resolveFinancialActorId(client, adminUser);

function validateDateRange(startDate, endDate) {
  if (!startDate && !endDate) return;

  let start;
  let end;

  if (startDate) {
    start = new Date(startDate);
    if (Number.isNaN(start.getTime())) {
      throw new BadRequestError('Invalid startDate format');
    }
  }

  if (endDate) {
    end = new Date(endDate);
    if (Number.isNaN(end.getTime())) {
      throw new BadRequestError('Invalid endDate format');
    }
  }

  if (start && end) {
    if (start > end) {
      throw new BadRequestError('startDate cannot be after endDate');
    }
    const maxRangeMs = 366 * 24 * 60 * 60 * 1000;
    if (end.getTime() - start.getTime() > maxRangeMs) {
      throw new BadRequestError('Date range cannot exceed 366 days');
    }
  }
}

class AdminWalletService {
  // ══════════════════════════════════════════════════════════════════════════════
  // WALLETS
  // ══════════════════════════════════════════════════════════════════════════════

  async listWallets(queryParams = {}) {
    const {
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
      page,
      limit,
      sortBy,
      sortOrder,
    } = queryParams;

    if (walletId) assertUuid(walletId, 'walletId');
    if (partnerId) assertUuid(partnerId, 'partnerId');
    validateDateRange(startDate, endDate);

    if (availableMin !== undefined && availableMin !== null) {
      const min = Number(availableMin);
      if (Number.isNaN(min) || min < 0) {
        throw new BadRequestError('availableMin must be a non-negative number');
      }
    }

    if (availableMax !== undefined && availableMax !== null) {
      const max = Number(availableMax);
      if (Number.isNaN(max) || max < 0) {
        throw new BadRequestError('availableMax must be a non-negative number');
      }
    }

    if (
      availableMin !== undefined
      && availableMax !== undefined
      && Number(availableMin) > Number(availableMax)
    ) {
      throw new BadRequestError('availableMin cannot exceed availableMax');
    }

    return adminWalletRepository.listWallets({
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
      page,
      limit,
      sortBy,
      sortOrder,
    });
  }

  async getWalletById(id) {
    assertUuid(id, 'walletId');
    const wallet = await adminWalletRepository.getWalletById(id);
    if (!wallet) {
      throw new NotFoundError('Wallet record not found');
    }
    return wallet;
  }

  async listWalletTransactions(walletId, queryParams = {}) {
    assertUuid(walletId, 'walletId');

    const wallet = await adminWalletRepository.getWalletById(walletId);
    if (!wallet) {
      throw new NotFoundError('Wallet record not found');
    }

    const {
      transactionType,
      direction,
      status,
      startDate,
      endDate,
      search,
      page,
      limit,
      sortBy,
      sortOrder,
    } = queryParams;

    validateDateRange(startDate, endDate);

    if (direction && !['CREDIT', 'DEBIT'].includes(String(direction).toUpperCase())) {
      throw new BadRequestError('direction must be either CREDIT or DEBIT');
    }

    return adminWalletRepository.listWalletTransactions(wallet.id, {
      transactionType,
      direction,
      status,
      startDate,
      endDate,
      search,
      page,
      limit,
      sortBy,
      sortOrder,
    });
  }

  async listWalletEarnings(walletId, queryParams = {}) {
    assertUuid(walletId, 'walletId');

    const wallet = await adminWalletRepository.getWalletById(walletId);
    if (!wallet) {
      throw new NotFoundError('Wallet record not found');
    }

    const {
      settlementStatus,
      startDate,
      endDate,
      page,
      limit,
    } = queryParams;

    validateDateRange(startDate, endDate);

    return adminWalletRepository.getWalletEarnings(wallet.partnerId, {
      settlementStatus,
      startDate,
      endDate,
      page,
      limit,
    });
  }

  async listWalletPayouts(walletId, queryParams = {}) {
    assertUuid(walletId, 'walletId');

    const wallet = await adminWalletRepository.getWalletById(walletId);
    if (!wallet) {
      throw new NotFoundError('Wallet record not found');
    }

    const {
      status,
      startDate,
      endDate,
      page,
      limit,
    } = queryParams;

    validateDateRange(startDate, endDate);

    return adminWalletRepository.getWalletPayouts(wallet.partnerId, {
      status,
      startDate,
      endDate,
      page,
      limit,
    });
  }

  async reconcileWallets() {
    return adminWalletRepository.reconcileWallets();
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // BANK ACCOUNTS
  // ══════════════════════════════════════════════════════════════════════════════

  async listBankAccounts(queryParams = {}) {
    const {
      partnerId,
      verificationStatus,
      search,
      page,
      limit,
      sortBy,
      sortOrder,
    } = queryParams;

    if (partnerId) assertUuid(partnerId, 'partnerId');

    return adminWalletRepository.listBankAccounts({
      partnerId,
      verificationStatus,
      search,
      page,
      limit,
      sortBy,
      sortOrder,
    });
  }

  async getBankAccountById(id) {
    assertUuid(id, 'bankAccountId');
    const bankAccount = await adminWalletRepository.getBankAccountById(id);
    if (!bankAccount) {
      throw new NotFoundError('Bank account record not found');
    }
    return bankAccount;
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // PAYOUTS
  // ══════════════════════════════════════════════════════════════════════════════

  async listPayouts(queryParams = {}) {
    const {
      payoutId,
      partnerId,
      bankAccountId,
      status,
      amountMin,
      amountMax,
      search,
      startDate,
      endDate,
      page,
      limit,
      sortBy,
      sortOrder,
    } = queryParams;

    if (payoutId) assertUuid(payoutId, 'payoutId');
    if (partnerId) assertUuid(partnerId, 'partnerId');
    if (bankAccountId) assertUuid(bankAccountId, 'bankAccountId');
    validateDateRange(startDate, endDate);

    if (amountMin !== undefined && amountMin !== null) {
      const min = Number(amountMin);
      if (Number.isNaN(min) || min < 0) {
        throw new BadRequestError('amountMin must be a non-negative number');
      }
    }

    if (amountMax !== undefined && amountMax !== null) {
      const max = Number(amountMax);
      if (Number.isNaN(max) || max < 0) {
        throw new BadRequestError('amountMax must be a non-negative number');
      }
    }

    if (
      amountMin !== undefined
      && amountMax !== undefined
      && Number(amountMin) > Number(amountMax)
    ) {
      throw new BadRequestError('amountMin cannot exceed amountMax');
    }

    return adminWalletRepository.listPayouts({
      payoutId,
      partnerId,
      bankAccountId,
      status,
      amountMin,
      amountMax,
      search,
      startDate,
      endDate,
      page,
      limit,
      sortBy,
      sortOrder,
    });
  }

  async getPayoutById(id) {
    assertUuid(id, 'payoutId');
    const payout = await adminWalletRepository.getPayoutById(id);
    if (!payout) {
      throw new NotFoundError('Payout record not found');
    }

    const [recentTransactions, previousPayouts] = await Promise.all([
      adminWalletRepository.getPartnerRecentTransactions(payout.partnerId, 10).catch(() => []),
      adminWalletRepository.getPartnerPreviousPayouts(payout.partnerId, payout.id, 10).catch(() => []),
    ]);

    return {
      ...payout,
      recentTransactions: recentTransactions || [],
      previousPayouts: previousPayouts || [],
    };
  }

  async getPayoutEvents(id) {
    assertUuid(id, 'payoutId');
    const payout = await adminWalletRepository.getPayoutById(id);
    if (!payout) {
      throw new NotFoundError('Payout record not found');
    }
    return adminWalletRepository.getPayoutEvents(id);
  }

  async getPayoutReconciliation() {
    return adminWalletRepository.getPayoutReconciliationSummary();
  }

  async markPaid(payoutId, payload, adminUser, auditMeta = {}) {
    assertUuid(payoutId, 'payoutId');
    const body = payload || {};
    const paymentMethod = (body.paymentMethod || 'MANUAL').trim();
    const paymentReference = (body.paymentReference || body.utr || '').trim();
    const notes = body.notes ? body.notes.trim() : null;

    if (!paymentReference) {
      throw new BadRequestError('Payment reference / UTR is mandatory');
    }
    if (paymentReference.length < 3) {
      throw new BadRequestError('Payment reference / UTR must be at least 3 characters');
    }

    return adminWalletRepository.executeInTransaction(async (client) => {
      // 1. Lock the payout/request row
      const payout = await adminWalletRepository.getPayoutForUpdate(client, payoutId);
      if (!payout) {
        throw new NotFoundError('Payout record not found');
      }

      const currentStatus = String(payout.status || '').toUpperCase();
      if (['PAID', 'COMPLETED'].includes(currentStatus)) {
        throw new ConflictError('Payout has already been marked as paid and settled');
      }
      if (['REJECTED', 'FAILED', 'CANCELLED'].includes(currentStatus)) {
        throw new ConflictError(`Cannot mark payout in terminal status '${currentStatus}' as paid`);
      }
      if (!['PENDING', 'REQUESTED'].includes(currentStatus)) {
        throw new BadRequestError(`Payout in status '${payout.status}' cannot be marked as paid`);
      }

      // 2. Lock the existing partner wallet row using existing wallet implementation
      const wallet = await adminWalletRepository.getWalletByPartnerIdForUpdate(
        client,
        payout.partner_id,
      );
      if (!wallet) {
        throw new NotFoundError('Associated partner wallet not found');
      }

      // 3. The amount was already debited (held) when the partner requested the payout —
      // see AdminWalletRepository.adjustPayoutHold. Marking it paid records the disbursement only; deducting
      // again would charge the partner twice.
      const currentAvailable = Number(wallet.available_balance || 0);
      const payoutAmount = Number(payout.amount);
      const newAvailable = currentAvailable;

      // 4. Ledger record of the disbursement (balance unchanged by this step)
      const tx = await adminWalletRepository.createWalletTransaction(client, {
        walletId: wallet.id,
        partnerId: payout.partner_id,
        transactionType: 'PAYOUT',
        direction: 'DEBIT',
        amount: payoutAmount,
        balanceBefore: currentAvailable,
        balanceAfter: newAvailable,
        referenceType: 'PAYOUT',
        referenceId: payout.id,
        status: 'COMPLETED',
        description: `Payout processed via ${paymentMethod} (Ref: ${paymentReference})`,
        metadata: {
          payoutId: payout.id,
          paymentMethod,
          utr: paymentReference,
          paymentReference,
          notes,
          adminId: adminUser ? adminUser.id : 'unknown',
        },
      });

      // 7. Resolve valid processed_by UUID that exists in users table to prevent 22P02 / 23503 errors
      const processedBy = await resolveAdminUserUuid(client, adminUser);

      // Update payout status to PAID
      const updatedRes = await client.query(
        `UPDATE partner_payouts
         SET
           status = 'paid',
           payment_reference = $2,
           provider_transfer_id = $2,
           payment_method = $3,
           notes = $4,
           processed_by = $5,
           processed_at = CURRENT_TIMESTAMP,
           completed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
        [
          payout.id,
          paymentReference,
          paymentMethod,
          notes,
          processedBy,
        ],
      );

      // 8. Record audit log
      await auditService.logAdminAction({
        actorId: adminUser.id || 'system-admin',
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'payouts.approve',
        action: 'PAYOUT_MARK_PAID',
        targetResource: 'payouts',
        targetResourceId: payout.id,
        beforeState: {
          status: payout.status,
          amount: payoutAmount,
          availableBalance: currentAvailable,
        },
        afterState: {
          status: 'PAID',
          paymentReference,
          paymentMethod,
          newAvailableBalance: newAvailable,
          transactionId: tx ? tx.id : null,
        },
        requestId: auditMeta.requestId || null,
        ipAddress: auditMeta.ipAddress || null,
        userAgent: auditMeta.userAgent || null,
        metadata: {
          partnerId: payout.partner_id,
          payoutId: payout.id,
          amount: payoutAmount,
          utr: paymentReference,
          paymentMethod,
          notes,
          adminId: adminUser.id,
        },
      });

      return {
        payout: updatedRes.rows[0],
        wallet: {
          id: wallet.id,
          previousAvailable: currentAvailable,
          availableBalance: newAvailable,
        },
        transaction: tx,
      };
    });
  }

  async approvePayout(payoutId, payload, adminUser, auditMeta = {}) {
    // If request contains payment reference / UTR, route to manual markPaid
    if (payload && (payload.paymentReference || payload.utr)) {
      return this.markPaid(payoutId, payload, adminUser, auditMeta);
    }

    assertUuid(payoutId, 'payoutId');
    const body = payload || {};

    return adminWalletRepository.executeInTransaction(async (client) => {
      const payout = await adminWalletRepository.getPayoutForUpdate(client, payoutId);
      if (!payout) {
        throw new NotFoundError('Payout record not found');
      }

      const currentStatus = String(payout.status || '').toUpperCase();
      if (['COMPLETED', 'PAID', 'FAILED', 'REJECTED', 'CANCELLED'].includes(currentStatus)) {
        throw new ConflictError(
          `Cannot approve payout in terminal status '${payout.status}'`,
        );
      }

      if (!['REQUESTED', 'PENDING'].includes(currentStatus)) {
        throw new BadRequestError(
          `Payout in status '${payout.status}' cannot be approved`,
        );
      }

      const wallet = await adminWalletRepository.getWalletByPartnerIdForUpdate(
        client,
        payout.partner_id,
      );
      if (!wallet) {
        throw new NotFoundError('Associated partner wallet not found');
      }

      const bankAccount = await adminWalletRepository.getBankAccountById(payout.bank_account_id);
      if (!bankAccount) {
        throw new NotFoundError('Associated bank account not found');
      }

      if (bankAccount.verificationStatus !== 'VERIFIED') {
        throw new BadRequestError(
          'Cannot disburse payout to an unverified bank account',
        );
      }

      // External Cashfree Payout transfer
      let providerTransferId = body.providerTransferId || null;
      let finalStatus = 'PROCESSING';

      try {
        const transferRes = await cashfreeProvider.initiatePayoutTransfer({
          transferId: `POT-${payout.id.slice(0, 8)}-${Date.now().toString().slice(-4)}`,
          amount: Number(payout.amount),
          beneficiaryDetails: {
            accountNumber: bankAccount.accountNumberMasked,
            ifscCode: bankAccount.ifscCode,
            accountHolderName: bankAccount.accountHolderName,
          },
          transferMode: body.transferMode || 'banktransfer',
          remarks: body.remarks || 'Admin approved payout disbursement',
        });

        if (transferRes.providerTransferId) {
          providerTransferId = transferRes.providerTransferId;
        }
        if (transferRes.transferStatus === 'SUCCESS') {
          finalStatus = 'COMPLETED';
        }
      } catch (err) {
        if (err instanceof BadRequestError) throw err;
      }

      const updated = await adminWalletRepository.updatePayoutStatus(client, payoutId, {
        status: finalStatus,
        providerTransferId,
        processedAt: new Date(),
      });

      // Audit action
      await auditService.logAdminAction({
        actorId: adminUser.id || 'system-admin',
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'payouts.approve',
        action: 'PAYOUT_APPROVE',
        targetResource: 'payouts',
        targetResourceId: payoutId,
        beforeState: {
          status: payout.status,
          amount: Number(payout.amount),
        },
        afterState: {
          status: finalStatus,
          providerTransferId,
        },
        requestId: auditMeta.requestId || null,
        ipAddress: auditMeta.ipAddress || null,
        userAgent: auditMeta.userAgent || null,
        metadata: {
          partnerId: payout.partner_id,
          amount: Number(payout.amount),
          remarks: body.remarks || 'Admin approved payout',
        },
      });

      return updated;
    });
  }

  async rejectPayout(payoutId, payload, adminUser, auditMeta = {}) {
    assertUuid(payoutId, 'payoutId');
    const body = payload || {};
    const { reason } = body;

    if (!reason || typeof reason !== 'string' || reason.trim().length < 3) {
      throw new BadRequestError('Rejection reason is mandatory and must be at least 3 characters');
    }
    if (reason.trim().length > 500) {
      throw new BadRequestError('Rejection reason cannot exceed 500 characters');
    }

    return adminWalletRepository.executeInTransaction(async (client) => {
      const payout = await adminWalletRepository.getPayoutForUpdate(client, payoutId);
      if (!payout) {
        throw new NotFoundError('Payout record not found');
      }

      const currentStatus = String(payout.status || '').toUpperCase();
      if (['COMPLETED', 'PAID'].includes(currentStatus)) {
        throw new ConflictError(
          `Cannot reject payout in terminal status '${payout.status}'`,
        );
      }
      if (['REJECTED', 'FAILED', 'CANCELLED'].includes(currentStatus)) {
        throw new ConflictError(
          `Payout is already in terminal status '${payout.status}'`,
        );
      }
      if (!['PENDING', 'REQUESTED'].includes(currentStatus)) {
        throw new BadRequestError(
          `Payout in status '${payout.status}' cannot be rejected`,
        );
      }

      // The amount was debited (held) when the partner requested the payout, so a
      // rejection must release it back to the available balance.
      const wallet = await adminWalletRepository.getWalletByPartnerIdForUpdate(
        client,
        payout.partner_id,
      );
      // Acting admin for processed_by, resolved before any balance change (never another admin)
      const processedBy = await resolveAdminUserUuid(client, adminUser);

      const refundAmount = Number(payout.amount);
      await adminWalletRepository.adjustPayoutHold(client, payout.partner_id, refundAmount);
      if (wallet) {
        await adminWalletRepository.createWalletTransaction(client, {
          walletId: wallet.id,
          partnerId: payout.partner_id,
          transactionType: 'PAYOUT_REVERSAL',
          direction: 'CREDIT',
          amount: refundAmount,
          balanceBefore: Number(wallet.available_balance || 0),
          balanceAfter: Math.round((Number(wallet.available_balance || 0) + refundAmount) * 100) / 100,
          referenceType: 'PAYOUT',
          referenceId: payout.id,
          status: 'COMPLETED',
          description: `Payout rejected by admin; held amount released: ${reason.trim()}`,
          metadata: { payoutId: payout.id, adminId: adminUser ? adminUser.id : 'unknown' },
        });
      }

      // Update payout status to 'rejected'
      const updatedRes = await client.query(
        `UPDATE partner_payouts
         SET
           status = 'rejected',
           failure_reason = $2,
           notes = COALESCE($3, notes),
           processed_by = $4,
           processed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
        [
          payoutId,
          reason.trim(),
          `Rejected by admin: ${reason.trim()}`,
          processedBy,
        ],
      );

      // Audit action
      await auditService.logAdminAction({
        actorId: adminUser.id || 'system-admin',
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'payouts.approve',
        action: 'PAYOUT_REJECT',
        targetResource: 'payouts',
        targetResourceId: payoutId,
        beforeState: {
          status: payout.status,
          amount: Number(payout.amount),
        },
        afterState: {
          status: 'REJECTED',
          failureReason: reason.trim(),
          availableBalance: wallet ? Number(wallet.available_balance) : null,
        },
        requestId: auditMeta.requestId || null,
        ipAddress: auditMeta.ipAddress || null,
        userAgent: auditMeta.userAgent || null,
        metadata: {
          partnerId: payout.partner_id,
          reason: reason.trim(),
          adminId: adminUser.id,
        },
      });

      return updatedRes.rows[0];
    });
  }

  async retryPayout(payoutId, payload, adminUser, auditMeta = {}) {
    assertUuid(payoutId, 'payoutId');
    const body = payload || {};

    return adminWalletRepository.executeInTransaction(async (client) => {
      const payout = await adminWalletRepository.getPayoutForUpdate(client, payoutId);
      if (!payout) {
        throw new NotFoundError('Payout record not found');
      }

      // partner_payouts.status is stored lowercase ('failed'); compare case-insensitively
      const retryFromStatus = String(payout.status || '').toUpperCase();
      if (retryFromStatus !== 'FAILED' && retryFromStatus !== 'CANCELLED') {
        throw new BadRequestError(
          `Only FAILED or CANCELLED payouts can be retried. Current status is '${payout.status}'`,
        );
      }

      const wallet = await adminWalletRepository.getWalletByPartnerIdForUpdate(
        client,
        payout.partner_id,
      );
      if (!wallet) {
        throw new NotFoundError('Associated partner wallet not found');
      }

      const retryAmount = Number(payout.amount);
      if (Number(wallet.available_balance) < retryAmount) {
        throw new BadRequestError(
          `Insufficient wallet balance to retry payout. Available: ₹${Number(wallet.available_balance).toFixed(2)}`,
        );
      }

      const newAvailable = Math.round(
        (Number(wallet.available_balance) - retryAmount) * 100,
      ) / 100;

      // Re-apply the hold that the failure reversal released (both wallet tables)
      await adminWalletRepository.adjustPayoutHold(client, payout.partner_id, -retryAmount);

      // Append immutable ledger entry
      await adminWalletRepository.createWalletTransaction(client, {
        walletId: wallet.id,
        partnerId: payout.partner_id,
        transactionType: 'PAYOUT',
        direction: 'DEBIT',
        amount: retryAmount,
        balanceAfter: newAvailable,
        referenceType: 'PAYOUT',
        referenceId: payout.id,
        status: 'COMPLETED',
        description: `Payout retry disbursement: ₹${retryAmount.toFixed(2)}`,
        metadata: {
          payoutId: payout.id,
          retry: true,
        },
      });

      // Update payout status back to REQUESTED or PROCESSING
      const updated = await adminWalletRepository.updatePayoutStatus(client, payoutId, {
        status: 'REQUESTED',
        failureReason: null,
        processedAt: null,
      });

      await auditService.logAdminAction({
        actorId: adminUser.id || 'system-admin',
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'payouts.approve',
        action: 'PAYOUT_RETRY',
        targetResource: 'payouts',
        targetResourceId: payoutId,
        beforeState: { status: payout.status },
        afterState: { status: 'REQUESTED' },
        requestId: auditMeta.requestId || null,
        ipAddress: auditMeta.ipAddress || null,
        userAgent: auditMeta.userAgent || null,
        metadata: {
          amount: retryAmount,
          reason: body.reason || 'Admin retried payout disbursement',
        },
      });

      return updated;
    });
  }

  async getPayoutTransactions(payoutId) {
    assertUuid(payoutId, 'payoutId');
    const payout = await adminWalletRepository.getPayoutById(payoutId);
    if (!payout) {
      throw new NotFoundError('Payout record not found');
    }
    const transactions = await adminWalletRepository.getPayoutTransactions(payoutId);
    return {
      payoutId,
      transactions,
    };
  }

  async adjustWallet(walletId, body = {}, adminUser, auditMeta = {}) {
    assertUuid(walletId, 'walletId');
    const { amount, direction, reason } = body;

    if (!amount || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
      throw new BadRequestError('Valid positive amount is required');
    }

    if (!direction || !['credit', 'debit', 'CREDIT', 'DEBIT'].includes(direction)) {
      throw new BadRequestError('direction must be either "credit" or "debit"');
    }

    if (!reason || typeof reason !== 'string' || reason.trim().length < 3) {
      throw new BadRequestError('reason is required and must be at least 3 characters');
    }

    // A client-supplied idempotency key makes retries safe: it becomes the ledger row's
    // reference_id and is checked under the wallet row lock, so the same adjustment can
    // never be applied twice (including concurrent duplicates).
    // Must be a UUID: it is stored in wallet_transactions.reference_id, which is a UUID column
    // in the live schema (Customer/scripts/supabase_schema.json).
    const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim().toLowerCase() : '';
    if (!UUID_REGEX.test(idempotencyKey)) {
      throw new BadRequestError('An Idempotency-Key (UUID) is required for wallet adjustments');
    }

    const normDirection = direction.toUpperCase();
    const adjustAmount = Math.round(Number(amount) * 100) / 100;

    return adminWalletRepository.executeInTransaction(async (client) => {
      const wallet = await adminWalletRepository.getWalletByIdForUpdate(client, walletId);
      if (!wallet) {
        throw new NotFoundError('Wallet not found');
      }

      const existing = await adminWalletRepository.findAdminAdjustmentByKey(
        client,
        wallet.partner_id,
        idempotencyKey,
      );
      if (existing) {
        const sameRequest = Math.abs(Number(existing.amount) - adjustAmount) < 0.005
          && String(existing.direction).toUpperCase() === normDirection;
        if (!sameRequest) {
          throw new ConflictError('Idempotency-Key was already used for a different wallet adjustment');
        }
        return {
          walletId,
          balanceBefore: existing.balance_before !== null && existing.balance_before !== undefined
            ? Number(existing.balance_before) : null,
          balanceAfter: Number(existing.balance_after),
          direction: normDirection,
          amount: adjustAmount,
          transaction: existing,
          idempotentReplay: true,
        };
      }

      // The acting admin (never another admin); resolved before any balance change and
      // refused if unresolvable
      const adminUuid = await resolveAdminUserUuid(client, adminUser);

      const balanceBefore = Number(wallet.available_balance || 0);
      let balanceAfter;

      if (normDirection === 'DEBIT') {
        if (balanceBefore < adjustAmount) {
          throw new BadRequestError(`Insufficient wallet balance for debit adjustment. Current: ₹${balanceBefore.toFixed(2)}`);
        }
        balanceAfter = Math.round((balanceBefore - adjustAmount) * 100) / 100;
      } else {
        balanceAfter = Math.round((balanceBefore + adjustAmount) * 100) / 100;
      }

      // Update wallet balance in both wallet tables (see adjustAvailableBalance)
      await adminWalletRepository.adjustAvailableBalance(
        client,
        wallet.partner_id,
        normDirection === 'DEBIT' ? -adjustAmount : adjustAmount,
      );

      // Persistent record of the adjustment. Partner's wallet recalculation sums these
      // admin_adjustment ledger rows, so the adjustment survives every recalculation.
      const tx = await adminWalletRepository.createWalletTransaction(client, {
        walletId,
        partnerId: wallet.partner_id,
        transactionType: 'ADMIN_ADJUSTMENT',
        direction: normDirection,
        amount: adjustAmount,
        balanceBefore,
        balanceAfter,
        referenceType: 'ADMIN',
        referenceId: idempotencyKey,
        status: 'COMPLETED',
        description: reason.trim(),
        metadata: {
          adjustedBy: adminUuid,
          adjustedByAuthId: adminUser ? adminUser.id : null,
          reason: reason.trim(),
          idempotencyKey,
        },
      });

      // Audit logging
      await auditService.logAdminAction({
        actorId: adminUser.id || 'system-admin',
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'wallets.adjust',
        action: 'adjust_wallet',
        targetResource: 'partner_wallets',
        targetResourceId: walletId,
        beforeState: { availableBalance: balanceBefore },
        afterState: { availableBalance: balanceAfter },
        requestId: auditMeta.requestId || null,
        ipAddress: auditMeta.ipAddress || null,
        userAgent: auditMeta.userAgent || null,
        metadata: {
          direction: normDirection,
          amount: adjustAmount,
          reason: reason.trim(),
          transactionId: tx ? tx.id : null,
        },
      });

      return {
        walletId,
        balanceBefore,
        balanceAfter,
        direction: normDirection,
        amount: adjustAmount,
        transaction: tx,
      };
    });
  }
}

module.exports = new AdminWalletService();
