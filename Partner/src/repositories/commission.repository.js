'use strict';

const BaseRepository = require('../db/base.repository');

class CommissionRepository extends BaseRepository {
  constructor() {
    super('commission_records', 'id');
  }

  /**
   * Create or calculate commission record for a booking.
   *
   * @param {object} data
   * @param {string} data.bookingId
   * @param {string} data.partnerId
   * @param {number} data.commissionRate (e.g. 0.1500 for 15%)
   * @param {number} data.commissionAmount
   * @param {number} data.grossBookingAmount
   * @param {number} data.partnerPayableAmount
   * @param {string} [data.status='CALCULATED']
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async createCommissionRecord(data, client = null) {
    const {
      bookingId,
      partnerId,
      commissionRate,
      commissionAmount,
      grossBookingAmount,
      partnerPayableAmount,
      status = 'CALCULATED',
    } = data;

    const sql = `
      INSERT INTO ${this.tableName} (
        booking_id, partner_id, commission_rate, commission_amount,
        gross_booking_amount, partner_payable_amount, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (booking_id) DO UPDATE SET
        commission_rate = EXCLUDED.commission_rate,
        commission_amount = EXCLUDED.commission_amount,
        gross_booking_amount = EXCLUDED.gross_booking_amount,
        partner_payable_amount = EXCLUDED.partner_payable_amount,
        status = EXCLUDED.status,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *;
    `;

    const params = [
      bookingId,
      partnerId,
      commissionRate,
      commissionAmount,
      grossBookingAmount,
      partnerPayableAmount,
      status,
    ];

    const res = client
      ? await client.query(sql, params)
      : await this.query(sql, params);

    return res.rows[0];
  }

  /**
   * Find paginated commission records (Admin only).
   *
   * @param {object} [options={}]
   * @param {number} [options.limit=20]
   * @param {number} [options.offset=0]
   * @param {string} [options.status]
   * @param {string} [options.partnerId]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ rows: Array<object>, total: number }>}
   */
  async findPaginated(options = {}, client = null) {
    const {
      limit = 20,
      offset = 0,
      status,
      partnerId,
    } = options;

    const whereClauses = [];
    const queryParams = [];
    let paramIndex = 1;

    if (status) {
      whereClauses.push(`c.status = $${paramIndex}`);
      queryParams.push(status);
      paramIndex += 1;
    }

    if (partnerId) {
      whereClauses.push(`c.partner_id = $${paramIndex}`);
      queryParams.push(partnerId);
      paramIndex += 1;
    }

    const whereSql = whereClauses.length > 0
      ? `WHERE ${whereClauses.join(' AND ')}`
      : '';

    // 1. Total count
    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM ${this.tableName} c
      ${whereSql};
    `;
    const countRes = client
      ? await client.query(countSql, queryParams)
      : await this.query(countSql, queryParams);
    const total = Number(countRes.rows[0]?.total || 0);

    // 2. Data rows query
    const dataSql = `
      SELECT
        c.id,
        c.booking_id,
        c.partner_id,
        c.commission_type,
        c.commission_rate,
        c.commission_amount,
        c.gross_booking_amount,
        c.partner_payable_amount,
        c.status,
        c.created_at,
        c.updated_at,
        b.booking_number,
        p.business_name AS partner_name
      FROM ${this.tableName} c
      LEFT JOIN bookings b ON b.id = c.booking_id
      LEFT JOIN partners p ON p.id = c.partner_id
      ${whereSql}
      ORDER BY c.created_at DESC, c.id DESC
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
   * Get aggregated platform commission summary (Admin only).
   *
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async getCommissionSummary(client = null) {
    const sql = `
      SELECT
        COALESCE(SUM(gross_booking_amount), 0)::numeric(12,2) AS total_gross_volume,
        COALESCE(SUM(commission_amount), 0)::numeric(12,2) AS total_commission_earned,
        COALESCE(SUM(partner_payable_amount), 0)::numeric(12,2) AS total_partner_payable,
        COUNT(*)::int AS total_bookings_commissioned
      FROM ${this.tableName};
    `;

    const res = client
      ? await client.query(sql)
      : await this.query(sql);

    const row = res.rows[0];
    return {
      totalGrossVolume: Number(row?.total_gross_volume || 0),
      totalCommissionEarned: Number(row?.total_commission_earned || 0),
      totalPartnerPayable: Number(row?.total_partner_payable || 0),
      totalBookingsCommissioned: Number(row?.total_bookings_commissioned || 0),
    };
  }
}

module.exports = CommissionRepository;
