'use strict';

const BaseRepository = require('../db/base.repository');

class AvailabilityRepository extends BaseRepository {
  constructor() {
    super('vehicle_availability_blocks', 'id');
  }

  /**
   * Find any active block overlapping with the given time window for a vehicle.
   * Overlap condition: existing.start_time < new.endTime AND existing.end_time > new.startTime
   *
   * @param {string} vehicleId
   * @param {Date|string} startTime
   * @param {Date|string} endTime
   * @param {string} [excludeBlockId]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findOverlappingBlocks(vehicleId, startTime, endTime, excludeBlockId = null, client = null) {
    let text = `
      SELECT id, vehicle_id, start_time, end_time, reason, is_active
      FROM ${this.tableName}
      WHERE vehicle_id = $1
        AND is_active = true
        AND start_time < $3
        AND end_time > $2
    `;
    const values = [vehicleId, startTime, endTime];

    if (excludeBlockId) {
      text += ' AND id != $4';
      values.push(excludeBlockId);
    }

    text += ' LIMIT 1;';

    const res = client
      ? await client.query(text, values)
      : await this.query(text, values);
    return res.rows[0] || null;
  }

  /**
   * Create an availability block for a vehicle.
   *
   * @param {object} blockData
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async createBlock(blockData, client = null) {
    const text = `
      INSERT INTO ${this.tableName} (
        vehicle_id, partner_id, start_time, end_time, reason, is_active, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *;
    `;
    const values = [
      blockData.vehicleId,
      blockData.partnerId || null,
      blockData.startTime,
      blockData.endTime,
      blockData.reason || 'Maintenance',
      blockData.isActive !== undefined ? blockData.isActive : true,
      blockData.createdBy || null,
    ];

    try {
      const res = client
        ? await client.query(text, values)
        : await this.query(text, values);
      return res.rows[0];
    } catch (err) {
      this.handleDbError(err, 'AvailabilityRepository.createBlock');
    }
  }

  /**
   * Find an availability block by block ID and vehicle ID.
   *
   * @param {string} blockId
   * @param {string} vehicleId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findBlockByIdAndVehicleId(blockId, vehicleId, client = null) {
    const text = `
      SELECT id, vehicle_id, start_time, end_time, reason, is_active, created_by, created_at, updated_at
      FROM ${this.tableName}
      WHERE id = $1 AND vehicle_id = $2
      LIMIT 1;
    `;
    const res = client
      ? await client.query(text, [blockId, vehicleId])
      : await this.query(text, [blockId, vehicleId]);
    return res.rows[0] || null;
  }

  /**
   * Find all availability blocks for a vehicle within an optional date range.
   *
   * @param {string} vehicleId
   * @param {object} [options]
   * @param {string|Date} [options.startDate]
   * @param {string|Date} [options.endDate]
   * @param {boolean} [options.isActive]
   * @param {number} [options.limit=100]
   * @param {number} [options.offset=0]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<Array<object>>}
   */
  async findBlocksByVehicleId(vehicleId, options = {}, client = null) {
    const {
      startDate,
      endDate,
      isActive = true,
      limit = 100,
      offset = 0,
    } = options;

    const values = [vehicleId];
    let idx = 2;
    const conditions = ['vehicle_id = $1'];

    if (isActive !== undefined && isActive !== null) {
      conditions.push(`is_active = $${idx}`);
      values.push(isActive);
      idx += 1;
    }

    if (startDate) {
      conditions.push(`end_time >= $${idx}`);
      values.push(startDate);
      idx += 1;
    }

    if (endDate) {
      conditions.push(`start_time <= $${idx}`);
      values.push(endDate);
      idx += 1;
    }

    values.push(limit);
    const limitParam = `$${idx}`;
    idx += 1;

    values.push(offset);
    const offsetParam = `$${idx}`;

    const text = `
      SELECT id, vehicle_id, start_time, end_time, reason, is_active, created_by, created_at, updated_at
      FROM ${this.tableName}
      WHERE ${conditions.join(' AND ')}
      ORDER BY start_time ASC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const res = client
      ? await client.query(text, values)
      : await this.query(text, values);
    return res.rows;
  }

  /**
   * Update an availability block.
   *
   * @param {string} blockId
   * @param {string} vehicleId
   * @param {object} updates
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async updateBlock(blockId, vehicleId, updates, client = null) {
    const setClauses = [];
    const values = [blockId, vehicleId];
    let idx = 3;

    if (updates.startTime !== undefined) {
      setClauses.push(`start_time = $${idx}`);
      values.push(updates.startTime);
      idx += 1;
    }

    if (updates.endTime !== undefined) {
      setClauses.push(`end_time = $${idx}`);
      values.push(updates.endTime);
      idx += 1;
    }

    if (updates.reason !== undefined) {
      setClauses.push(`reason = $${idx}`);
      values.push(updates.reason);
      idx += 1;
    }

    if (updates.isActive !== undefined) {
      setClauses.push(`is_active = $${idx}`);
      values.push(updates.isActive);
      idx += 1;
    }

    if (setClauses.length === 0) {
      return this.findBlockByIdAndVehicleId(blockId, vehicleId, client);
    }

    setClauses.push('updated_at = CURRENT_TIMESTAMP');

    const text = `
      UPDATE ${this.tableName}
      SET ${setClauses.join(', ')}
      WHERE id = $1 AND vehicle_id = $2
      RETURNING *;
    `;

    try {
      const res = client
        ? await client.query(text, values)
        : await this.query(text, values);
      return res.rows[0] || null;
    } catch (err) {
      this.handleDbError(err, 'AvailabilityRepository.updateBlock');
    }
  }

  /**
   * Soft delete / deactivate an availability block.
   *
   * @param {string} blockId
   * @param {string} vehicleId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async deactivateBlock(blockId, vehicleId, client = null) {
    const text = `
      UPDATE ${this.tableName}
      SET is_active = false, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND vehicle_id = $2 AND is_active = true
      RETURNING *;
    `;
    const res = client
      ? await client.query(text, [blockId, vehicleId])
      : await this.query(text, [blockId, vehicleId]);
    return res.rows[0] || null;
  }
}

module.exports = new AvailabilityRepository();
