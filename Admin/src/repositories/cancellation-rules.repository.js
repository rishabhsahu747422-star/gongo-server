'use strict';

const BaseRepository = require('../db/base.repository');

let mockCancellationRulesResolver = null;

function setMockCancellationRulesResolver(resolver) {
  mockCancellationRulesResolver = resolver;
}

function resetMockCancellationRulesResolver() {
  mockCancellationRulesResolver = null;
}

const DEFAULT_RULES = {
  bike: [
    { tier: 1, noticeHours: 6, refundPercentage: 0 },
    { tier: 2, noticeHours: 12, refundPercentage: 50 },
    { tier: 3, noticeHours: 24, refundPercentage: 100 },
  ],
  car: [
    { tier: 1, noticeHours: 12, refundPercentage: 0 },
    { tier: 2, noticeHours: 24, refundPercentage: 50 },
    { tier: 3, noticeHours: 24, refundPercentage: 100 },
  ],
};

function formatRow(row) {
  return {
    id: row.id,
    tier: Number(row.tier),
    noticeHours: Number(row.notice_hours),
    refundPercentage: Number(row.refund_percentage),
  };
}

class CancellationRulesRepository extends BaseRepository {
  constructor() {
    super('cancellation_refund_rules', 'id');
  }

  async _exec(sql, params = [], client = null) {
    if (client) {
      return client.query(sql, params);
    }
    return this.query(sql, params);
  }

  /**
   * Retrieves active cancellation rules for a specific vehicle type.
   *
   * @param {'bike'|'car'} vehicleType
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<Array<object>>}
   */
  async findByVehicleType(vehicleType, client = null) {
    if (
      mockCancellationRulesResolver
      && typeof mockCancellationRulesResolver.findByVehicleType === 'function'
    ) {
      return mockCancellationRulesResolver.findByVehicleType(vehicleType);
    }

    const type = String(vehicleType).toLowerCase();
    const sql = `
      SELECT id, vehicle_type, tier, notice_hours, refund_percentage, is_active
      FROM cancellation_refund_rules
      WHERE vehicle_type = $1 AND is_active = TRUE
      ORDER BY tier ASC;
    `;

    const res = await this._exec(sql, [type], client);
    if (!res.rows || res.rows.length === 0) {
      return DEFAULT_RULES[type] || [];
    }
    return res.rows.map(formatRow);
  }

  /**
   * Retrieves all active cancellation rules grouped by bike and car.
   *
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ bike: Array<object>, car: Array<object> }>}
   */
  async findAll(client = null) {
    if (
      mockCancellationRulesResolver
      && typeof mockCancellationRulesResolver.findAll === 'function'
    ) {
      return mockCancellationRulesResolver.findAll();
    }

    const sql = `
      SELECT id, vehicle_type, tier, notice_hours, refund_percentage, is_active
      FROM cancellation_refund_rules
      WHERE is_active = TRUE
      ORDER BY vehicle_type, tier ASC;
    `;

    const res = await this._exec(sql, [], client);
    const result = {
      bike: [],
      car: [],
    };

    if (res.rows && res.rows.length > 0) {
      res.rows.forEach((row) => {
        const type = String(row.vehicle_type).toLowerCase();
        if (result[type]) {
          result[type].push(formatRow(row));
        }
      });
    }

    if (result.bike.length === 0) {
      result.bike = [...DEFAULT_RULES.bike];
    }
    if (result.car.length === 0) {
      result.car = [...DEFAULT_RULES.car];
    }

    return result;
  }

  /**
   * Atomically updates rules for a single vehicle type.
   *
   * @param {object} params
   * @param {'bike'|'car'} params.vehicleType
   * @param {Array<object>} params.rules
   * @param {string|null} [params.adminId]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<Array<object>>}
   */
  async updateRulesForVehicleType({ vehicleType, rules, adminId = null }, client = null) {
    if (
      mockCancellationRulesResolver
      && typeof mockCancellationRulesResolver.updateRulesForVehicleType === 'function'
    ) {
      return mockCancellationRulesResolver.updateRulesForVehicleType({
        vehicleType,
        rules,
        adminId,
      });
    }

    const type = String(vehicleType).toLowerCase();

    const executeInTransaction = async (dbClient) => {
      // 1. Lock existing rows for this vehicle type
      await dbClient.query(
        `SELECT id FROM cancellation_refund_rules
         WHERE vehicle_type = $1
         FOR UPDATE;`,
        [type],
      );

      // 2. Clear old rules for this vehicle type
      await dbClient.query(
        'DELETE FROM cancellation_refund_rules WHERE vehicle_type = $1;',
        [type],
      );

      // 3. Insert each re-sequenced rule
      const inserted = [];
      for (let i = 0; i < rules.length; i += 1) {
        const r = rules[i];
        const tier = i + 1;
        const noticeHours = Number(r.noticeHours ?? r.notice_hours);
        const refundPercentage = Number(r.refundPercentage ?? r.refund_percentage);

        // eslint-disable-next-line no-await-in-loop
        const insertRes = await dbClient.query(
          `INSERT INTO cancellation_refund_rules
           (vehicle_type, tier, notice_hours, refund_percentage, is_active, created_by)
           VALUES ($1, $2, $3, $4, TRUE, $5)
           RETURNING id, vehicle_type, tier, notice_hours, refund_percentage, is_active;`,
          [type, tier, noticeHours, refundPercentage, adminId],
        );
        inserted.push(formatRow(insertRes.rows[0]));
      }

      return inserted;
    };

    if (client) {
      return executeInTransaction(client);
    }

    return this.withTransaction(async (dbClient) => executeInTransaction(dbClient));
  }

  /**
   * Atomically updates rules for both bike and car in a single transaction.
   *
   * @param {object} params
   * @param {Array<object>} params.bike
   * @param {Array<object>} params.car
   * @param {string|null} [params.adminId]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ bike: Array<object>, car: Array<object> }>}
   */
  async updateAllRules({ bike, car, adminId = null }, client = null) {
    if (
      mockCancellationRulesResolver
      && typeof mockCancellationRulesResolver.updateAllRules === 'function'
    ) {
      return mockCancellationRulesResolver.updateAllRules({ bike, car, adminId });
    }

    const executeInTransaction = async (dbClient) => {
      const updatedBike = await this.updateRulesForVehicleType(
        { vehicleType: 'bike', rules: bike, adminId },
        dbClient,
      );
      const updatedCar = await this.updateRulesForVehicleType(
        { vehicleType: 'car', rules: car, adminId },
        dbClient,
      );
      return { bike: updatedBike, car: updatedCar };
    };

    if (client) {
      return executeInTransaction(client);
    }

    return this.withTransaction(async (dbClient) => executeInTransaction(dbClient));
  }
}

module.exports = CancellationRulesRepository;
module.exports.setMockCancellationRulesResolver = setMockCancellationRulesResolver;
module.exports.resetMockCancellationRulesResolver = resetMockCancellationRulesResolver;
module.exports.DEFAULT_RULES = DEFAULT_RULES;
