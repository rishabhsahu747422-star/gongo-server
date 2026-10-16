'use strict';

const BaseRepository = require('../db/base.repository');
const { roundMoney } = require('../utils/money');

let mockPlatformFeeResolver = null;

function setMockPlatformFeeResolver(resolver) {
  mockPlatformFeeResolver = resolver;
}

function resetMockPlatformFeeResolver() {
  mockPlatformFeeResolver = null;
}

const DEFAULT_CHARGES = {
  serviceCharge: {
    calculationType: 'fixed',
    value: 2.50,
    currency: 'INR',
  },
  convenienceFee: {
    calculationType: 'fixed',
    value: 2.00,
    currency: 'INR',
  },
  gst: {
    calculationType: 'percentage',
    value: 18.00,
  },
};

const DEFAULT_CAR_CHARGES = {
  serviceCharge: {
    calculationType: 'fixed',
    value: 5.00,
    currency: 'INR',
  },
  convenienceFee: {
    calculationType: 'fixed',
    value: 3.00,
    currency: 'INR',
  },
  gst: {
    calculationType: 'percentage',
    value: 18.00,
  },
};

function mapRowsToPlatformCharges(rows, vehicleType = 'bike') {
  const isCar = String(vehicleType).toLowerCase().trim() === 'car';
  const defaults = isCar ? DEFAULT_CAR_CHARGES : DEFAULT_CHARGES;

  const result = {
    serviceCharge: { ...defaults.serviceCharge },
    convenienceFee: { ...defaults.convenienceFee },
    gst: { ...defaults.gst },
  };

  if (!Array.isArray(rows) || rows.length === 0) {
    return result;
  }

  rows.forEach((row) => {
    if (!row) return;
    const chargeType = row.charge_type;
    const item = {
      id: row.id,
      calculationType: row.calculation_type,
      value: roundMoney(row.value),
      currency: row.currency || 'INR',
      isActive: Boolean(row.is_active),
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    if (isCar) {
      if (chargeType === 'service_charge_car') {
        result.serviceCharge = item;
      } else if (chargeType === 'convenience_fee_car') {
        result.convenienceFee = item;
      } else if (chargeType === 'gst_car') {
        result.gst = item;
      }
    } else {
      if (chargeType === 'service_charge') {
        result.serviceCharge = item;
      } else if (chargeType === 'convenience_fee') {
        result.convenienceFee = item;
      } else if (chargeType === 'gst') {
        result.gst = item;
      }
    }
  });

  return result;
}

function mapRowsToAllPlatformCharges(rows) {
  const bike = mapRowsToPlatformCharges(rows, 'bike');
  const car = mapRowsToPlatformCharges(rows, 'car');
  return {
    ...bike,
    bike,
    car,
  };
}

class PlatformFeeRepository extends BaseRepository {
  constructor() {
    super('platform_charge_settings', 'id');
  }

  /**
   * Helper to execute queries or dispatch to mock resolver if registered.
   */
  async _exec(sql, params = [], client = null) {
    if (mockPlatformFeeResolver && typeof mockPlatformFeeResolver === 'function') {
      return mockPlatformFeeResolver(sql, params);
    }
    if (client) {
      return client.query(sql, params);
    }
    return this.query(sql, params);
  }

  /**
   * Retrieves active platform charge settings.
   *
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async findActive(vehicleTypeOrClient = null, maybeClient = null) {
    let vehicleType = null;
    let client = null;

    if (typeof vehicleTypeOrClient === 'string') {
      vehicleType = vehicleTypeOrClient.toLowerCase().trim();
      client = maybeClient;
    } else if (vehicleTypeOrClient && typeof vehicleTypeOrClient.query === 'function') {
      client = vehicleTypeOrClient;
    }

    if (mockPlatformFeeResolver && typeof mockPlatformFeeResolver.findActive === 'function') {
      return mockPlatformFeeResolver.findActive(vehicleType);
    }

    const sql = `
      SELECT id, charge_type, calculation_type, value, currency, is_active, created_by, created_at, updated_at
      FROM platform_charge_settings
      WHERE is_active = TRUE
      ORDER BY charge_type;
    `;
    const res = await this._exec(sql, [], client);
    const rows = res.rows || [];

    if (vehicleType === 'car') {
      return mapRowsToPlatformCharges(rows, 'car');
    }
    if (vehicleType === 'bike') {
      return mapRowsToPlatformCharges(rows, 'bike');
    }
    if (vehicleType === 'all') {
      return {
        bike: mapRowsToPlatformCharges(rows, 'bike'),
        car: mapRowsToPlatformCharges(rows, 'car'),
      };
    }
    return mapRowsToAllPlatformCharges(rows);
  }

  /**
   * Updates active platform charges in a transaction with row-level locking.
   *
   * @param {object} params
   * @param {number} params.serviceCharge
   * @param {number} params.convenienceFee
   * @param {number} params.gst
   * @param {string|null} [params.adminId=null]
   * @param {string} [params.vehicleType='bike']
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ previous: object, current: object, vehicleType: string }>}
   */
  async updateActiveCharges(
    { serviceCharge, convenienceFee, gst, adminId = null, vehicleType = 'bike' },
    client = null,
  ) {
    const isCar = String(vehicleType).toLowerCase().trim() === 'car';

    if (
      mockPlatformFeeResolver
      && typeof mockPlatformFeeResolver.updateActiveCharges === 'function'
    ) {
      return mockPlatformFeeResolver.updateActiveCharges({
        serviceCharge,
        convenienceFee,
        gst,
        adminId,
        vehicleType: isCar ? 'car' : 'bike',
      });
    }

    const transactionRunner = async (dbClient) => {
      // 1. Lock existing active rows
      const lockSql = `
        SELECT id, charge_type, calculation_type, value, currency, is_active, created_by, created_at, updated_at
        FROM platform_charge_settings
        WHERE is_active = TRUE
        FOR UPDATE;
      `;
      const activeRes = await dbClient.query(lockSql);
      const previousRows = activeRes.rows || [];

      // Resolve valid admin user UUID in users table
      let validAdminId = null;
      const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (adminId && typeof adminId === 'string' && UUID_REGEX.test(adminId.trim())) {
        try {
          const userCheck = await dbClient.query(
            'SELECT id FROM users WHERE id = $1 LIMIT 1;',
            [adminId.trim()],
          );
          if (userCheck.rows && userCheck.rows.length > 0) {
            validAdminId = userCheck.rows[0].id;
          }
        } catch (_) {
          // Fall back gracefully if user check query cannot be executed
        }
      }

      const chargeUpdates = isCar ? [
        {
          chargeType: 'service_charge_car',
          calculationType: 'fixed',
          value: roundMoney(serviceCharge),
        },
        {
          chargeType: 'convenience_fee_car',
          calculationType: 'fixed',
          value: roundMoney(convenienceFee),
        },
        {
          chargeType: 'gst_car',
          calculationType: 'percentage',
          value: roundMoney(gst),
        },
      ] : [
        {
          chargeType: 'service_charge',
          calculationType: 'fixed',
          value: roundMoney(serviceCharge),
        },
        {
          chargeType: 'convenience_fee',
          calculationType: 'fixed',
          value: roundMoney(convenienceFee),
        },
        {
          chargeType: 'gst',
          calculationType: 'percentage',
          value: roundMoney(gst),
        },
      ];

      const saveCharge = async (item) => {
        const existing = previousRows.find((r) => r.charge_type === item.chargeType);
        const finalAdminId = validAdminId || (existing ? existing.created_by : null);

        if (existing) {
          const updateSql = `
            UPDATE platform_charge_settings
            SET
              calculation_type = $1,
              value = $2,
              currency = 'INR',
              created_by = $3,
              updated_at = NOW()
            WHERE id = $4 AND is_active = TRUE
            RETURNING id, charge_type, calculation_type, value, currency, is_active, created_by, created_at, updated_at;
          `;
          const res = await dbClient.query(updateSql, [
            item.calculationType,
            item.value,
            finalAdminId,
            existing.id,
          ]);
          return res.rows[0];
        }

        const insertSql = `
          INSERT INTO platform_charge_settings (
            charge_type,
            calculation_type,
            value,
            currency,
            is_active,
            created_by,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, 'INR', TRUE, $4, NOW(), NOW())
          RETURNING id, charge_type, calculation_type, value, currency, is_active, created_by, created_at, updated_at;
        `;
        const res = await dbClient.query(insertSql, [
          item.chargeType,
          item.calculationType,
          item.value,
          finalAdminId,
        ]);
        return res.rows[0];
      };

      const row1 = await saveCharge(chargeUpdates[0]);
      const row2 = await saveCharge(chargeUpdates[1]);
      const row3 = await saveCharge(chargeUpdates[2]);

      // Query all current active rows so we return complete updated snapshot
      const currentRes = await dbClient.query(`
        SELECT id, charge_type, calculation_type, value, currency, is_active, created_by, created_at, updated_at
        FROM platform_charge_settings
        WHERE is_active = TRUE
        ORDER BY charge_type;
      `);
      const currentRows = currentRes.rows || [row1, row2, row3];

      const previousMapped = isCar
        ? mapRowsToPlatformCharges(previousRows, 'car')
        : mapRowsToPlatformCharges(previousRows, 'bike');
      const currentMapped = isCar
        ? mapRowsToPlatformCharges(currentRows, 'car')
        : mapRowsToPlatformCharges(currentRows, 'bike');

      return {
        previous: previousMapped,
        current: currentMapped,
        vehicleType: isCar ? 'car' : 'bike',
      };
    };

    if (client) {
      return transactionRunner(client);
    }
    return this.withTransaction(transactionRunner);
  }

  /**
   * Backward compatibility adapter for legacy single fee update.
   */
  async updateActiveFee(
    { feeType, feeValue, currency = 'INR', adminId = null, vehicleType = 'bike' },
    client = null,
  ) {
    if (
      mockPlatformFeeResolver
      && typeof mockPlatformFeeResolver.updateActiveFee === 'function'
    ) {
      return mockPlatformFeeResolver.updateActiveFee({
        feeType,
        feeValue,
        currency,
        adminId,
        vehicleType,
      });
    }

    const current = await this.findActive(vehicleType, client);
    const serviceCharge = current.serviceCharge?.value ?? (vehicleType === 'car' ? 5.00 : 2.50);
    const convenienceFee = feeType === 'fixed'
      ? feeValue
      : (current.convenienceFee?.value ?? (vehicleType === 'car' ? 3.00 : 2.00));
    const gst = feeType === 'percentage'
      ? feeValue
      : (current.gst?.value ?? 18.00);

    return this.updateActiveCharges(
      { serviceCharge, convenienceFee, gst, adminId, vehicleType },
      client,
    );
  }
}

const defaultInstance = new PlatformFeeRepository();

module.exports = defaultInstance;
module.exports.PlatformFeeRepository = PlatformFeeRepository;
module.exports.mapRowsToPlatformCharges = mapRowsToPlatformCharges;
module.exports.mapRowsToAllPlatformCharges = mapRowsToAllPlatformCharges;
module.exports.DEFAULT_CHARGES = DEFAULT_CHARGES;
module.exports.DEFAULT_CAR_CHARGES = DEFAULT_CAR_CHARGES;
module.exports.setMockPlatformFeeResolver = setMockPlatformFeeResolver;
module.exports.resetMockPlatformFeeResolver = resetMockPlatformFeeResolver;
