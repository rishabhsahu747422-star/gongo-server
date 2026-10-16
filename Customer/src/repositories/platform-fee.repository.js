'use strict';

const BaseRepository = require('./base.repository');
const { roundMoney } = require('../utils/money');

function mapRowToPlatformFee(row) {
  if (!row) return null;
  return {
    id: row.id,
    feeType: row.fee_type,
    feeValue: roundMoney(row.fee_value),
    currency: row.currency,
    isActive: Boolean(row.is_active),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class PlatformFeeRepository extends BaseRepository {
  /**
   * Finds active platform charges from the authoritative platform_charge_settings table.
   *
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<Array<object>>}
   */
  async findActiveCharges(client = null) {
    const sql = `
      SELECT id, charge_type, calculation_type, value, currency, is_active, created_by, created_at, updated_at
      FROM platform_charge_settings
      WHERE is_active = TRUE
      ORDER BY charge_type;
    `;
    try {
      const res = client ? await client.query(sql) : await this.query(sql);
      return res.rows || [];
    } catch (err) {
      // In tests where platform_charge_settings might not exist in pg-mem
      if (err.message && (err.message.includes('platform_charge_settings') || err.message.includes('does not exist'))) {
        return [];
      }
      throw this.handleDatabaseError(err);
    }
  }

  /**
   * Finds the currently active platform fee configuration.
   *
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findActive(client = null) {
    const sql = `
      SELECT id, fee_type, fee_value, currency, is_active, created_by, created_at, updated_at
      FROM platform_fee_settings
      WHERE is_active = TRUE
      LIMIT 1;
    `;
    try {
      const res = client ? await client.query(sql) : await this.query(sql);
      if (!res.rows || res.rows.length === 0) {
        return null;
      }
      return mapRowToPlatformFee(res.rows[0]);
    } catch (err) {
      if (err.message && err.message.includes('platform_fee_settings')) {
        // Fallback: Check if platform_charge_settings has convenience fee
        try {
          const charges = await this.findActiveCharges(client);
          const cf = charges.find((c) => c.charge_type === 'convenience_fee');
          if (cf) {
            return {
              id: cf.id,
              feeType: cf.calculation_type,
              feeValue: roundMoney(cf.value),
              currency: cf.currency || 'INR',
              isActive: Boolean(cf.is_active),
              createdBy: cf.created_by,
              createdAt: cf.created_at,
              updatedAt: cf.updated_at,
            };
          }
        } catch {
          // ignore
        }
        return null;
      }
      throw this.handleDatabaseError(err);
    }
  }
}

module.exports = PlatformFeeRepository;
module.exports.mapRowToPlatformFee = mapRowToPlatformFee;
