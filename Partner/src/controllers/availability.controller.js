'use strict';

const availabilityService = require('../services/availability.service');
const availabilityValidator = require('../validators/availability.validator');
const { sendSuccess } = require('../utils/response');

class AvailabilityController {
  /**
   * GET /api/v1/partner/vehicles/:vehicleId/availability
   */
  async getAvailability(req, res, next) {
    try {
      const { partnerId } = req.user;
      const { vehicleId } = req.params;
      const options = availabilityValidator.validateAvailabilityQuery(req.query);
      const blocks = await availabilityService.getVehicleAvailability({
        vehicleId,
        partnerId,
        options,
      });
      sendSuccess(res, blocks, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/partner/vehicles/:vehicleId/availability
   */
  async createBlock(req, res, next) {
    try {
      const { partnerId, userId } = req.user;
      const { vehicleId } = req.params;
      const blockData = availabilityValidator.validateCreateBlock(req.body);
      const created = await availabilityService.createAvailabilityBlock({
        vehicleId,
        partnerId,
        blockData,
        actorId: userId || partnerId,
        requestId: req.id,
      });
      sendSuccess(res, created, 201);
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/v1/partner/vehicles/:vehicleId/availability/:blockId
   */
  async updateBlock(req, res, next) {
    try {
      const { partnerId, userId } = req.user;
      const { vehicleId, blockId } = req.params;
      const updates = availabilityValidator.validateUpdateBlock(req.body);
      const updated = await availabilityService.updateAvailabilityBlock({
        blockId,
        vehicleId,
        partnerId,
        updates,
        actorId: userId || partnerId,
        requestId: req.id,
      });
      sendSuccess(res, updated, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * DELETE /api/v1/partner/vehicles/:vehicleId/availability/:blockId
   */
  async deleteBlock(req, res, next) {
    try {
      const { partnerId, userId } = req.user;
      const { vehicleId, blockId } = req.params;
      const result = await availabilityService.deleteAvailabilityBlock({
        blockId,
        vehicleId,
        partnerId,
        actorId: userId || partnerId,
        requestId: req.id,
      });
      sendSuccess(res, result, 200);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new AvailabilityController();
