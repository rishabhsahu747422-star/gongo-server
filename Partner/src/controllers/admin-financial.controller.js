'use strict';

const adminFinancialService = require('../services/admin-financial.service');
const { sendSuccess } = require('../utils/response');
const { HTTP_STATUS } = require('../constants/http');

class AdminFinancialController {
  /**
   * GET /api/v1/admin/financials/settlements
   * List platform-wide booking settlements.
   */
  async listSettlements(req, res, next) {
    try {
      const result = await adminFinancialService.listSettlements(req.validatedQuery);
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/financials/commissions
   * List platform commission records (Internal/Confidential).
   */
  async listCommissions(req, res, next) {
    try {
      const result = await adminFinancialService.listCommissions(req.validatedQuery);
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/financials/summary
   * Platform-wide financial summary.
   */
  async getFinancialSummary(req, res, next) {
    try {
      const result = await adminFinancialService.getFinancialSummary();
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/payouts
   * List platform payouts.
   */
  async listPayouts(req, res, next) {
    try {
      const result = await adminFinancialService.listPayouts(req.validatedQuery);
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/payouts/:payoutId
   * Get single payout details.
   */
  async getPayoutById(req, res, next) {
    try {
      const { payoutId } = req.params;
      const result = await adminFinancialService.getPayoutById(payoutId);
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/payouts/:payoutId/process
   * Move payout to PROCESSING.
   */
  async processPayout(req, res, next) {
    try {
      const { payoutId } = req.params;
      const result = await adminFinancialService.processPayout(payoutId, req.validatedBody);
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/payouts/:payoutId/complete
   * Complete payout.
   */
  async completePayout(req, res, next) {
    try {
      const { payoutId } = req.params;
      const result = await adminFinancialService.completePayout(payoutId);
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/payouts/:payoutId/fail
   * Fail payout and reverse wallet debit.
   */
  async failPayout(req, res, next) {
    try {
      const { payoutId } = req.params;
      const result = await adminFinancialService.failPayout(payoutId, req.validatedBody);
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/financials/reconciliation
   * Run platform-wide financial reconciliation audit.
   */
  async getReconciliationReport(req, res, next) {
    try {
      const result = await adminFinancialService.getReconciliationReport();
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AdminFinancialController();
