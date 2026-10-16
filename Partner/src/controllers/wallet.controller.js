'use strict';

const walletService = require('../services/wallet.service');
const { sendSuccess } = require('../utils/response');
const { HTTP_STATUS } = require('../constants/http');

/**
 * WalletController — Read-only handlers for Partner wallet balances and ledger transactions.
 */
class WalletController {
  /**
   * GET /api/v1/partner/wallet
   * Retrieves summary of wallet balances, totals, and currency for authenticated partner.
   */
  async getWallet(req, res, next) {
    try {
      const { partnerId } = req.user;
      const summary = await walletService.getWalletSummary(partnerId);
      return sendSuccess(res, summary, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/partner/wallet/transactions
   * Retrieves paginated, chronologically sorted transaction ledger records with optional filters.
   */
  async getTransactions(req, res, next) {
    try {
      const { partnerId } = req.user;
      const result = await walletService.getTransactionHistory(partnerId, req.validatedQuery);
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/partner/wallet/transactions/:transactionId
   * Retrieves single transaction details with strict BOLA enforcement.
   */
  async getTransactionById(req, res, next) {
    try {
      const { partnerId } = req.user;
      const { transactionId } = req.params;
      const transaction = await walletService.getTransactionDetails(partnerId, transactionId);
      return sendSuccess(res, transaction, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new WalletController();
