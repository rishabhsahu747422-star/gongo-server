'use strict';

const BaseRepository = require('../db/base.repository');

class DamageReportRepository extends BaseRepository {
  constructor() {
    super('damage_reports', 'id');
  }

  /**
   * Find paginated damage reports with optional filters and joined details.
   *
   * @param {object} [options={}]
   * @param {number} [options.limit=20]
   * @param {number} [options.offset=0]
   * @param {string} [options.status]
   * @param {string} [options.bookingId]
   * @param {string} [options.vehicleId]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ rows: Array<object>, total: number }>}
   */
  async findPaginated(options = {}, client = null) {
    const {
      limit = 20,
      offset = 0,
      status,
      bookingId,
      vehicleId,
    } = options;

    const whereClauses = [];
    const queryParams = [];
    let paramIndex = 1;

    if (status) {
      whereClauses.push(`d.status = $${paramIndex}`);
      queryParams.push(status);
      paramIndex += 1;
    }

    if (bookingId) {
      whereClauses.push(`d.booking_id = $${paramIndex}`);
      queryParams.push(bookingId);
      paramIndex += 1;
    }

    if (vehicleId) {
      whereClauses.push(`d.vehicle_id = $${paramIndex}`);
      queryParams.push(vehicleId);
      paramIndex += 1;
    }

    const whereSql = whereClauses.length > 0
      ? `WHERE ${whereClauses.join(' AND ')}`
      : '';

    // 1. Total count query
    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM ${this.tableName} d
      ${whereSql};
    `;
    const countRes = client
      ? await client.query(countSql, queryParams)
      : await this.query(countSql, queryParams);
    const total = Number(countRes.rows[0]?.total || 0);

    // 2. Data rows query
    const dataSql = `
      SELECT
        d.id,
        d.booking_id,
        d.vehicle_id,
        d.reported_by,
        d.damage_type,
        d.description,
        d.estimated_amount,
        d.approved_amount,
        d.status,
        d.photos,
        d.created_at,
        d.updated_at,
        b.booking_number,
        v.registration_number,
        v.brand,
        v.model
      FROM ${this.tableName} d
      LEFT JOIN bookings b ON b.id = d.booking_id
      LEFT JOIN vehicles v ON v.id = d.vehicle_id
      ${whereSql}
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1};
    `;

    const dataParams = [...queryParams, limit, offset];
    const dataRes = client
      ? await client.query(dataSql, dataParams)
      : await this.query(dataSql, dataParams);

    return {
      rows: dataRes.rows,
      total,
    };
  }

  /**
   * Find single damage report with joined booking and vehicle context.
   *
   * @param {string} id
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findById(id, client = null) {
    const sql = `
      SELECT
        d.id,
        d.booking_id,
        d.vehicle_id,
        d.reported_by,
        d.damage_type,
        d.description,
        d.estimated_amount,
        d.approved_amount,
        d.status,
        d.photos,
        d.created_at,
        d.updated_at,
        b.booking_number,
        v.registration_number,
        v.brand,
        v.model
      FROM ${this.tableName} d
      LEFT JOIN bookings b ON b.id = d.booking_id
      LEFT JOIN vehicles v ON v.id = d.vehicle_id
      WHERE d.id = $1
      LIMIT 1;
    `;

    const res = client
      ? await client.query(sql, [id])
      : await this.query(sql, [id]);

    return res.rows[0] || null;
  }

  /**
   * Update damage report status and approved amount.
   *
   * @param {string} id
   * @param {object} updateData
   * @param {string} updateData.status
   * @param {number} [updateData.approvedAmount]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async updateStatus(id, updateData, client = null) {
    const { status, approvedAmount = null } = updateData;

    const sql = `
      UPDATE ${this.tableName}
      SET
        status = $1,
        approved_amount = COALESCE($2, approved_amount),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *;
    `;

    const params = [status, approvedAmount, id];
    const res = client
      ? await client.query(sql, params)
      : await this.query(sql, params);

    return res.rows[0] || null;
  }
}

module.exports = DamageReportRepository;
