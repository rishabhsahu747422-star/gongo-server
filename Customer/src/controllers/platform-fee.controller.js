'use strict';

const platformFeeService = require('../services/platform-fee.service');
const { sendSuccess } = require('../utils/response');

class PlatformFeeController {
  constructor(service = platformFeeService) {
    this.service = service;
  }

  /**
   * GET /api/v1/customer/platform-fee
   * GET /api/v1/platform-fee
   *
   * Returns active platform fee configuration for checkout calculation and display.
   * Internal fields (id, createdBy, createdAt, updatedAt, isActive) are not exposed.
   */
  async getPlatformFee(req, res, next) {
    try {
      const active = await this.service.getActivePlatformFee();

      const customerData = {
        feeType: active.feeType,
        feeValue: active.feeValue,
        currency: active.currency,
      };

      return sendSuccess(res, customerData, 'Active platform fee retrieved successfully');
    } catch (err) {
      return next(err);
    }
  }
}

const defaultInstance = new PlatformFeeController();

module.exports = defaultInstance;
module.exports.PlatformFeeController = PlatformFeeController;
