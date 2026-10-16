'use strict';

const EarningsRepository = require('../repositories/earnings.repository');
const { NotFoundError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

const earningsSummaryCache = new Map();
const SUMMARY_CACHE_TTL_MS = 15000;

class EarningsService {
  constructor(earningsRepo = new EarningsRepository()) {
    this.earningsRepository = earningsRepo;
  }

  /**
   * Retrieves paginated, filtered earnings records for the authenticated partner.
   *
   * @param {string} partnerId
   * @param {object} options
   * @returns {Promise<object>}
   */
  async getEarnings(partnerId, options = {}) {
    const { rows, total } = await this.earningsRepository.findPaginatedByPartnerId(
      partnerId,
      options,
    );

    const items = rows.map((row) => ({
      id: row.id,
      partnerId: row.partner_id,
      bookingId: row.booking_id,
      bookingNumber: row.booking_number || null,
      walletTransactionId: row.wallet_transaction_id,
      grossAmount: Number(Number(row.gross_amount || 0).toFixed(2)),
      partnerNetAmount: Number(Number(row.partner_net_amount || 0).toFixed(2)),
      ...(row.commission_amount !== undefined && row.commission_amount !== null
        ? {
            commissionAmount: Number(Number(row.commission_amount).toFixed(2)),
            commissionRate: Number(Number(row.commission_rate || 0).toFixed(2)),
            partnerEarning: Number(Number(row.partner_net_amount || 0).toFixed(2)),
          }
        : {}),
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
   * Retrieves aggregated earnings summary for the authenticated partner.
   *
   * @param {string} partnerId
   * @returns {Promise<object>}
   */
  async getEarningsSummary(partnerId) {
    if (process.env.NODE_ENV !== 'test') {
      const cached = earningsSummaryCache.get(partnerId);
      if (cached && Date.now() < cached.expiresAt) {
        return cached.summary;
      }
    }

    const summary = await this.earningsRepository.getSummaryByPartnerId(partnerId);

    if (process.env.NODE_ENV !== 'test') {
      earningsSummaryCache.set(partnerId, {
        summary,
        expiresAt: Date.now() + SUMMARY_CACHE_TTL_MS,
      });
    }

    return summary;
  }

  /**
   * Retrieves a single earnings record with strict BOLA double-ownership check.
   *
   * @param {string} partnerId
   * @param {string} earningId
   * @returns {Promise<object>}
   */
  async getEarningById(partnerId, earningId) {
    const earning = await this.earningsRepository.findByIdAndPartnerId(
      earningId,
      partnerId,
    );

    if (!earning) {
      throw new NotFoundError(
        'Earnings record not found or unauthorized',
        ERROR_CODES.NOT_FOUND,
      );
    }

    return {
      id: earning.id,
      partnerId: earning.partner_id,
      bookingId: earning.booking_id,
      bookingNumber: earning.booking_number || null,
      walletTransactionId: earning.wallet_transaction_id,
      grossAmount: Number(Number(earning.gross_amount || 0).toFixed(2)),
      partnerNetAmount: Number(Number(earning.partner_net_amount || 0).toFixed(2)),
      ...(earning.commission_amount !== undefined && earning.commission_amount !== null
        ? {
            commissionAmount: Number(Number(earning.commission_amount).toFixed(2)),
            commissionRate: Number(Number(earning.commission_rate || 0).toFixed(2)),
            partnerEarning: Number(Number(earning.partner_net_amount || 0).toFixed(2)),
          }
        : {}),
      settlementStatus: earning.settlement_status,
      settledAt: earning.settled_at,
      createdAt: earning.created_at,
      updatedAt: earning.updated_at,
    };
  }
}

module.exports = new EarningsService();
