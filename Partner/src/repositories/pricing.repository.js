'use strict';

const BaseRepository = require('../db/base.repository');

class PricingRepository extends BaseRepository {
  constructor() {
    super('vehicle_pricing', 'id');
  }

  /**
   * Find active pricing configuration for a vehicle.
   *
   * @param {string} vehicleId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findByVehicleId(vehicleId, client = null) {
    const text = `
      SELECT 
        id, vehicle_id, price_per_hour, price_3_hours, price_6_hours, price_12_hours,
        price_per_4_hours, price_per_day,
        security_deposit, extra_km_charge, currency, is_active,
        created_at, updated_at
      FROM ${this.tableName}
      WHERE vehicle_id = $1
      LIMIT 1;
    `;
    const res = client
      ? await client.query(text, [vehicleId])
      : await this.query(text, [vehicleId]);
    return res.rows[0] || null;
  }

  /**
   * Upsert pricing configuration for a vehicle.
   *
   * @param {string} vehicleId
   * @param {object} pricingData
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async upsertPricing(vehicleId, pricingData, client = null) {
    const text = `
      INSERT INTO ${this.tableName} (
        vehicle_id, pricing_type, price, price_per_hour, price_3_hours, price_6_hours, price_12_hours,
        price_per_4_hours, price_per_day, security_deposit, extra_km_charge, currency, is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (vehicle_id) DO UPDATE SET
        pricing_type = EXCLUDED.pricing_type,
        price = EXCLUDED.price,
        price_per_hour = EXCLUDED.price_per_hour,
        price_3_hours = EXCLUDED.price_3_hours,
        price_6_hours = EXCLUDED.price_6_hours,
        price_12_hours = EXCLUDED.price_12_hours,
        price_per_4_hours = EXCLUDED.price_per_4_hours,
        price_per_day = EXCLUDED.price_per_day,
        security_deposit = EXCLUDED.security_deposit,
        extra_km_charge = EXCLUDED.extra_km_charge,
        currency = EXCLUDED.currency,
        is_active = EXCLUDED.is_active,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *;
    `;
    const values = [
      vehicleId,
      'daily',
      pricingData.pricePerDay ?? 0.00,
      pricingData.pricePerHour ?? 0.00,
      pricingData.price3Hours !== undefined ? pricingData.price3Hours : null,
      pricingData.price6Hours !== undefined ? pricingData.price6Hours : null,
      pricingData.price12Hours !== undefined ? pricingData.price12Hours : null,
      pricingData.pricePer4Hours ?? 0.00,
      pricingData.pricePerDay ?? 0.00,
      pricingData.securityDeposit ?? 0.00,
      pricingData.extraKmCharge ?? 0.00,
      pricingData.currency || 'INR',
      pricingData.isActive !== undefined ? pricingData.isActive : true,
    ];

    try {
      const res = client
        ? await client.query(text, values)
        : await this.query(text, values);
      return res.rows[0];
    } catch (err) {
      this.handleDbError(err, 'PricingRepository.upsertPricing');
    }
  }

  /**
   * Close any currently open pricing history record for a vehicle.
   *
   * @param {string} vehicleId
   * @param {Date|string} closedAt
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async closeOpenHistoryRecord(vehicleId, closedAt, client = null) {
    const text = `
      UPDATE vehicle_pricing_history
      SET valid_to = $2
      WHERE vehicle_id = $1 AND valid_to IS NULL
      RETURNING *;
    `;
    const res = client
      ? await client.query(text, [vehicleId, closedAt])
      : await this.query(text, [vehicleId, closedAt]);
    return res.rows[0] || null;
  }

  /**
   * Insert a new pricing history record.
   *
   * @param {object} historyData
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async createHistoryRecord(historyData, client = null) {
    const text = `
      INSERT INTO vehicle_pricing_history (
        vehicle_id, price_per_hour, price_3_hours, price_6_hours, price_12_hours,
        price_per_4_hours, price_per_day,
        security_deposit, extra_km_charge, valid_from, valid_to, effective_from, effective_to,
        changed_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $10, $11, $12)
      RETURNING *;
    `;
    const values = [
      historyData.vehicleId,
      historyData.pricePerHour,
      historyData.price3Hours !== undefined ? historyData.price3Hours : null,
      historyData.price6Hours !== undefined ? historyData.price6Hours : null,
      historyData.price12Hours !== undefined ? historyData.price12Hours : null,
      historyData.pricePer4Hours,
      historyData.pricePerDay,
      historyData.securityDeposit,
      historyData.extraKmCharge,
      historyData.validFrom || new Date().toISOString(),
      historyData.validTo || null,
      historyData.changedBy || null,
    ];

    try {
      const res = client
        ? await client.query(text, values)
        : await this.query(text, values);
      return res.rows[0];
    } catch (err) {
      this.handleDbError(err, 'PricingRepository.createHistoryRecord');
    }
  }

  /**
   * Get pricing change history for a vehicle.
   *
   * @param {string} vehicleId
   * @param {object} [options]
   * @param {number} [options.limit=50]
   * @param {number} [options.offset=0]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<Array<object>>}
   */
  async getPricingHistory(vehicleId, options = {}, client = null) {
    const { limit = 50, offset = 0 } = options;
    const text = `
      SELECT 
        id, vehicle_id, price_per_hour, price_3_hours, price_6_hours, price_12_hours,
        price_per_4_hours, price_per_day,
        security_deposit, extra_km_charge, valid_from, valid_to, changed_by, created_at
      FROM vehicle_pricing_history
      WHERE vehicle_id = $1
      ORDER BY valid_from DESC, created_at DESC
      LIMIT $2 OFFSET $3;
    `;
    const res = client
      ? await client.query(text, [vehicleId, limit, offset])
      : await this.query(text, [vehicleId, limit, offset]);
    return res.rows;
  }
}

module.exports = new PricingRepository();
