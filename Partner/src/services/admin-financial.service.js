'use strict';

const EarningsRepository = require('../repositories/earnings.repository');
const CommissionRepository = require('../repositories/commission.repository');
const PayoutRepository = require('../repositories/payout.repository');
const payoutService = require('./payout.service');
const notificationService = require('./notification.service');
const reconciliationService = require('./reconciliation.service');
const outboxService = require('./outbox.service');
const { NotFoundError, BadRequestError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

class AdminFinancialService {
  constructor(
    earningsRepo = new EarningsRepository(),
    commissionRepo = new CommissionRepository(),
    payoutRepo = new PayoutRepository(),
    reconciliationServ = reconciliationService,
  ) {
    this.earningsRepository = earningsRepo;
    this.commissionRepository = commissionRepo;
    this.payoutRepository = payoutRepo;
    this.reconciliationService = reconciliationServ;
  }

  /**
   * List platform-wide booking settlements & earnings (Admin only).
   *
   * @param {object} options
   * @returns {Promise<object>}
   */
  async listSettlements(options = {}) {
    const { rows, total } = await this.earningsRepository.findPaginatedAdmin(options);

    const items = rows.map((row) => ({
      id: row.id,
      partnerId: row.partner_id,
      partnerName: row.partner_name || null,
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
   * List platform commission records (Admin only).
   *
   * @param {object} options
   * @returns {Promise<object>}
   */
  async listCommissions(options = {}) {
    const { rows, total } = await this.commissionRepository.findPaginated(options);

    const items = rows.map((row) => ({
      id: row.id,
      bookingId: row.booking_id,
      bookingNumber: row.booking_number || null,
      partnerId: row.partner_id,
      partnerName: row.partner_name || null,
      commissionType: row.commission_type,
      commissionRate: Number(Number(row.commission_rate || 0).toFixed(4)),
      commissionAmount: Number(Number(row.commission_amount || 0).toFixed(2)),
      grossBookingAmount: Number(Number(row.gross_booking_amount || 0).toFixed(2)),
      partnerPayableAmount: Number(Number(row.partner_payable_amount || 0).toFixed(2)),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

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
   * Aggregate platform-wide financial metrics (Admin only).
   *
   * @returns {Promise<object>}
   */
  async getFinancialSummary() {
    const commissionSummary = await this.commissionRepository.getCommissionSummary();
    return {
      ...commissionSummary,
    };
  }

  /**
   * List platform-wide payout requests (Admin only).
   *
   * @param {object} options
   * @returns {Promise<object>}
   */
  async listPayouts(options = {}) {
    const { rows, total } = await this.payoutRepository.findPaginatedAdmin(options);

    const items = rows.map((row) => ({
      id: row.id,
      partnerId: row.partner_id,
      partnerName: row.partner_name || null,
      bankAccountId: row.bank_account_id,
      bankAccount: {
        accountHolderName: row.account_holder_name,
        accountNumberMasked: row.account_number_masked,
        bankName: row.bank_name,
        ifscCode: row.ifsc_code,
      },
      amount: Number(Number(row.amount || 0).toFixed(2)),
      status: row.status,
      providerTransferId: row.provider_transfer_id || null,
      failureReason: row.failure_reason || null,
      idempotencyKey: row.idempotency_key || null,
      requestedAt: row.requested_at,
      processedAt: row.processed_at || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

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
   * Get single payout details for Admin.
   *
   * @param {string} payoutId
   * @returns {Promise<object>}
   */
  async getPayoutById(payoutId) {
    const payout = await this.payoutRepository.findByIdAdmin(payoutId);
    if (!payout) {
      throw new NotFoundError('Payout record not found', ERROR_CODES.NOT_FOUND);
    }

    return {
      id: payout.id,
      partnerId: payout.partner_id,
      partnerName: payout.partner_name || null,
      bankAccountId: payout.bank_account_id,
      bankAccount: {
        accountHolderName: payout.account_holder_name,
        accountNumberMasked: payout.account_number_masked,
        bankName: payout.bank_name,
        ifscCode: payout.ifsc_code,
      },
      amount: Number(Number(payout.amount || 0).toFixed(2)),
      status: payout.status,
      providerTransferId: payout.provider_transfer_id || null,
      failureReason: payout.failure_reason || null,
      idempotencyKey: payout.idempotency_key || null,
      requestedAt: payout.requested_at,
      processedAt: payout.processed_at || null,
      createdAt: payout.created_at,
      updatedAt: payout.updated_at,
    };
  }

  /**
   * Moves payout to PROCESSING.
   *
   * @param {string} payoutId
   * @param {object} [payload={}]
   * @param {string} [payload.providerTransferId]
   * @returns {Promise<object>}
   */
  async processPayout(payoutId, payload = {}) {
    const payout = await this.payoutRepository.findByIdAdmin(payoutId);
    if (!payout) {
      throw new NotFoundError('Payout record not found', ERROR_CODES.NOT_FOUND);
    }

    if (payout.status === 'PROCESSING') {
      if (payload.providerTransferId
        && payout.provider_transfer_id !== payload.providerTransferId) {
        await this.payoutRepository.updateStatus(payoutId, {
          status: 'PROCESSING',
          providerTransferId: payload.providerTransferId,
        });
      }
      return this.getPayoutById(payout.id);
    }

    if (payout.status !== 'REQUESTED') {
      throw new BadRequestError(
        `Payout in status '${payout.status}' cannot be moved to PROCESSING`,
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    const updated = await this.payoutRepository.updateStatus(payoutId, {
      status: 'PROCESSING',
      providerTransferId: payload.providerTransferId || null,
    });

    return this.getPayoutById(updated.id);
  }

  /**
   * Completes payout and notifies partner.
   *
   * @param {string} payoutId
   * @returns {Promise<object>}
   */
  async completePayout(payoutId) {
    const payout = await this.payoutRepository.findByIdAdmin(payoutId);
    if (!payout) {
      throw new NotFoundError('Payout record not found', ERROR_CODES.NOT_FOUND);
    }

    if (payout.status === 'COMPLETED') {
      return this.getPayoutById(payout.id);
    }

    if (!['REQUESTED', 'PROCESSING'].includes(payout.status)) {
      throw new BadRequestError(
        `Payout in status '${payout.status}' cannot be marked COMPLETED`,
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    const updated = await this.payoutRepository.updateStatus(payoutId, {
      status: 'COMPLETED',
    });

    // Notify partner
    try {
      await notificationService.dispatchNotification({
        partnerId: payout.partner_id,
        type: 'PAYOUT_COMPLETED',
        title: 'Payout Disbursed',
        body: `Your payout withdrawal of ₹${Number(payout.amount).toFixed(2)} has been successfully transferred to your bank account.`,
        payload: { payoutId: payout.id, amount: payout.amount },
        eventKey: `PAYOUT_COMPLETED:${payout.id}`,
      });
    } catch (_) {
      // Non-blocking notification dispatch
    }

    await outboxService.recordEvent({
      eventType: 'PAYOUT_COMPLETED',
      aggregateType: 'PAYOUT',
      aggregateId: payout.id,
      payload: { partnerId: payout.partner_id, payoutId: payout.id, amount: payout.amount },
    }).catch(() => {});

    return this.getPayoutById(updated.id);
  }

  /**
   * Fails payout, triggering atomic wallet balance reversal and ledger entry.
   *
   * @param {string} payoutId
   * @param {object} payload
   * @param {string} payload.failureReason
   * @returns {Promise<object>}
   */
  async failPayout(payoutId, payload) {
    const { failureReason } = payload;
    const payout = await this.payoutRepository.findByIdAdmin(payoutId);
    if (!payout) {
      throw new NotFoundError('Payout record not found', ERROR_CODES.NOT_FOUND);
    }

    if (payout.status === 'FAILED') {
      return this.getPayoutById(payout.id);
    }

    if (!['REQUESTED', 'PROCESSING'].includes(payout.status)) {
      throw new BadRequestError(
        `Payout in status '${payout.status}' cannot be failed`,
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    await payoutService.handlePayoutFailureOrReversal(payoutId, failureReason);

    // Notify partner
    try {
      await notificationService.dispatchNotification({
        partnerId: payout.partner_id,
        type: 'PAYOUT_FAILED',
        title: 'Payout Failed & Balance Restored',
        body: `Your payout withdrawal of ₹${Number(payout.amount).toFixed(2)} could not be processed: ${failureReason}. The amount has been credited back to your wallet.`,
        payload: { payoutId: payout.id, amount: payout.amount, failureReason },
        eventKey: `PAYOUT_FAILED:${payout.id}`,
      });
    } catch (_) {
      // Non-blocking notification dispatch
    }

    await outboxService.recordEvent({
      eventType: 'PAYOUT_FAILED',
      aggregateType: 'PAYOUT',
      aggregateId: payout.id,
      payload: {
        partnerId: payout.partner_id,
        payoutId: payout.id,
        amount: payout.amount,
        failureReason,
      },
    }).catch(() => {});

    return this.getPayoutById(payoutId);
  }

  /**
   * Run platform-wide financial reconciliation audit.
   *
   * @returns {Promise<object>}
   */
  async getReconciliationReport() {
    return this.reconciliationService.runPlatformReconciliation();
  }
}

module.exports = new AdminFinancialService();
