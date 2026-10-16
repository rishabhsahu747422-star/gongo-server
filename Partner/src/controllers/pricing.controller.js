'use strict';

const pricingService = require('../services/pricing.service');
const pricingValidator = require('../validators/pricing.validator');
const { sendSuccess } = require('../utils/response');

class PricingController {
  /**
   * GET /api/v1/partner/vehicles/:vehicleId/pricing
   */
  async getPricing(req, res, next) {
    try {
      const { partnerId } = req.user;
      const { vehicleId } = req.params;
      const pricing = await pricingService.getVehiclePricing({ vehicleId, partnerId });
      sendSuccess(res, pricing, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * PUT /api/v1/partner/vehicles/:vehicleId/pricing
   */
  async updatePricing(req, res, next) {
    try {
      const { partnerId, userId } = req.user;
      const { vehicleId } = req.params;
      const validatedData = pricingValidator.validatePricing(req.body);
      const pricing = await pricingService.updateVehiclePricing({
        vehicleId,
        partnerId,
        pricingData: validatedData,
        actorId: userId || partnerId,
        changedBy: userId || null,
        requestId: req.id,
      });
      sendSuccess(res, pricing, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/partner/vehicles/:vehicleId/pricing/history
   */
  async getPricingHistory(req, res, next) {
    try {
      const { partnerId } = req.user;
      const { vehicleId } = req.params;
      const options = pricingValidator.validateHistoryQuery(req.query);
      const history = await pricingService.getPricingHistory({
        vehicleId,
        partnerId,
        options,
      });
      sendSuccess(res, history, 200);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new PricingController();
