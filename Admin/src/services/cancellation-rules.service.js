'use strict';

const CancellationRulesRepository = require('../repositories/cancellation-rules.repository');
const { validateCancellationRulesPayload } = require('../validators/cancellation-rules.validator');

class CancellationRulesService {
  constructor(deps = {}) {
    this.repository = deps.repository || new CancellationRulesRepository();
  }

  /**
   * Retrieves active cancellation rules.
   *
   * @param {string|null} [vehicleType=null] Optional filter ('bike' | 'car')
   * @returns {Promise<object>}
   */
  async getRules(vehicleType = null) {
    if (vehicleType) {
      const type = String(vehicleType).toLowerCase().trim();
      if (type === 'bike' || type === 'car') {
        const rules = await this.repository.findByVehicleType(type);
        return {
          vehicleType: type,
          rules,
        };
      }
    }

    return this.repository.findAll();
  }

  /**
   * Updates cancellation rules transactionally.
   *
   * @param {object} payload
   * @param {string|null} [adminId=null]
   * @returns {Promise<object>}
   */
  async updateRules(payload, adminId = null) {
    const validated = validateCancellationRulesPayload(payload);

    if (validated.mode === 'all') {
      const result = await this.repository.updateAllRules({
        bike: validated.bike,
        car: validated.car,
        adminId,
      });
      return {
        mode: 'all',
        data: result,
      };
    }

    const updated = await this.repository.updateRulesForVehicleType({
      vehicleType: validated.vehicleType,
      rules: validated.rules,
      adminId,
    });

    return {
      mode: 'single',
      vehicleType: validated.vehicleType,
      rules: updated,
    };
  }
}

module.exports = CancellationRulesService;
