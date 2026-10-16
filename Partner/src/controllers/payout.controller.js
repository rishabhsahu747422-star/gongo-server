'use strict';

const payoutService = require('../services/payout.service');
const { sendSuccess } = require('../utils/response');
const { HTTP_STATUS } = require('../constants/http');

class PayoutController {
  /**
   * POST /api/v1/partner/payouts
   * Requests a payout withdrawal.
   */
  async requestPayout(req, res, next) {
    try {
      const { partnerId } = req.user;
      const result = await payoutService.requestPayout(partnerId, req.validatedBody);
      return sendSuccess(res, result, HTTP_STATUS.CREATED);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/partner/payouts
   * List paginated payouts for the authenticated partner.
   */
  async getPayouts(req, res, next) {
    try {
      const { partnerId } = req.user;
      const result = await payoutService.getPayouts(partnerId, req.validatedQuery);
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/partner/payouts/:payoutId
   * Get single payout details for the authenticated partner.
   */
  async getPayoutById(req, res, next) {
    try {
      const { partnerId } = req.user;
      const { payoutId } = req.params;
      const payout = await payoutService.getPayoutById(partnerId, payoutId);
      return sendSuccess(res, payout, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new PayoutController();
