'use strict';

const CancellationRulesService = require('../services/cancellation-rules.service');
const { sendSuccess } = require('../utils/response');

const defaultService = new CancellationRulesService();

class AdminCancellationRulesController {
  constructor(service = defaultService) {
    this.service = service;
  }

  /**
   * GET /admin/cancellation-rules
   */
  async getCancellationRules(req, res, next) {
    try {
      const vehicleType = req.query?.vehicleType || req.query?.type || null;
      const data = await this.service.getRules(vehicleType);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PUT /admin/cancellation-rules
   */
  async updateCancellationRules(req, res, next) {
    try {
      const adminId = req.user?.id || null;
      const result = await this.service.updateRules(req.body, adminId);

      if (req.audit) {
        req.audit({
          action: 'CANCELLATION_RULES_UPDATE',
          targetResource: 'CANCELLATION_REFUND_RULES',
          targetResourceId: result.vehicleType || 'all_vehicles',
          afterState: result.data || result.rules,
          metadata: {
            mode: result.mode,
            vehicleType: result.vehicleType,
          },
        });
      }

      // If single mode, also fetch full state so frontend has complete synced rules
      const fullRules = await this.service.getRules();

      return sendSuccess(res, {
        message: 'Cancellation rules updated successfully.',
        updated: result,
        ...fullRules,
      });
    } catch (err) {
      return next(err);
    }
  }
}

const defaultInstance = new AdminCancellationRulesController();

module.exports = defaultInstance;
module.exports.AdminCancellationRulesController = AdminCancellationRulesController;
