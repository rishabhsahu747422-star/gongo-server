'use strict';

const earningsService = require('../services/earnings.service');
const { sendSuccess } = require('../utils/response');
const { HTTP_STATUS } = require('../constants/http');

/**
 * EarningsController — Read-only handlers for Partner earnings records and summaries.
 */
class EarningsController {
  /**
   * GET /api/v1/partner/earnings
   * Retrieves paginated, filtered list of earnings for the authenticated partner.
   */
  async getEarnings(req, res, next) {
    try {
      const { partnerId } = req.user;
      const result = await earningsService.getEarnings(partnerId, req.validatedQuery);
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/partner/earnings/summary
   * Retrieves aggregated earnings metrics for the authenticated partner.
   */
  async getSummary(req, res, next) {
    try {
      const { partnerId } = req.user;
      const summary = await earningsService.getEarningsSummary(partnerId);
      return sendSuccess(res, summary, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/partner/earnings/:earningId
   * Retrieves a single earnings record with strict BOLA enforcement.
   */
  async getEarningById(req, res, next) {
    try {
      const { partnerId } = req.user;
      const { earningId } = req.params;
      const earning = await earningsService.getEarningById(partnerId, earningId);
      return sendSuccess(res, earning, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new EarningsController();
