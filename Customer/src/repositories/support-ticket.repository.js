'use strict';

const crypto = require('crypto');
const BaseRepository = require('./base.repository');
const { TICKET_STATUS, TICKET_PRIORITY, TICKET_CATEGORY } = require('../constants/support');

/**
 * SupportTicketRepository — database operations for customer support tickets mapped to Supabase schema.
 * Table: public.support_tickets (id, ticket_number, user_id, booking_id, vehicle_id, subject, description, category, priority, status)
 */
class SupportTicketRepository extends BaseRepository {
  /**
   * Projects database row to customer-safe DTO.
   *
   * @param {object|null} row
   * @returns {object|null}
   */
  static mapDto(row) {
    if (!row) return null;

    let status = row.status;
    if (status === 'waiting_for_user' || status === 'waiting_for_customer') {
      status = 'WAITING_FOR_CUSTOMER';
    } else if (status) {
      status = status.toUpperCase();
    }

    return {
      id: row.id,
      ticketNumber: row.ticket_number,
      customerId: row.user_id || row.customer_id,
      bookingId: row.booking_id || null,
      bookingReference: row.booking_reference || row.booking_number || null,
      vehicleId: row.vehicle_id || null,
      category: row.category ? row.category.toUpperCase() : row.category,
      subject: row.subject,
      description: row.description || row.subject,
      priority: row.priority ? row.priority.toUpperCase() : row.priority,
      status,
      resolvedAt: row.resolved_at instanceof Date
        ? row.resolved_at.toISOString()
        : (row.resolved_at || null),
      closedAt: row.closed_at instanceof Date
        ? row.closed_at.toISOString()
        : (row.closed_at || null),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    };
  }

  /**
   * Generates a unique, human-readable ticket number.
   * Format: TKT-<YYYYMMDD>-<6_CHAR_HEX>
   *
   * @returns {string}
   */
  static generateTicketNumber() {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const randomHex = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `TKT-${today}-${randomHex}`;
  }

  /**
   * Creates a new support ticket.
   *
   * @param {object} params
   * @param {string} params.customerId
   * @param {string} [params.bookingId]
   * @param {string} [params.vehicleId]
   * @param {string} params.category
   * @param {string} params.subject
   * @param {string} [params.description]
   * @param {string} [params.priority]
   * @param {string} [params.status]
   * @param {string} [params.ticketNumber]
   * @param {object} [client]
   * @returns {Promise<object>}
   */
  async create(
    {
      customerId,
      bookingId = null,
      vehicleId = null,
      category = TICKET_CATEGORY.OTHER,
      subject,
      description = null,
      priority = TICKET_PRIORITY.MEDIUM,
      status = TICKET_STATUS.OPEN,
      ticketNumber = null,
    },
    client = null,
  ) {
    const num = ticketNumber || SupportTicketRepository.generateTicketNumber();
    const safeDesc = description || subject || 'No description provided';
    const safeCat = (category || 'OTHER').toUpperCase();
    const safePri = (priority || 'MEDIUM').toUpperCase();
    const safeStat = (status || 'OPEN').toUpperCase();

    const runner = client || this;
    const sql = `
      INSERT INTO support_tickets (
        user_id, customer_id, booking_id, ticket_number, category, subject, description, priority, status
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9
      )
      RETURNING *
    `;
    const res = await runner.query(sql, [
      customerId,
      customerId,
      bookingId,
      num,
      safeCat,
      subject,
      safeDesc,
      safePri,
      safeStat,
    ]);
    return SupportTicketRepository.mapDto(res.rows[0]);
  }

  /**
   * Finds a support ticket by primary key.
   *
   * @param {string} id
   * @param {object} [client]
   * @returns {Promise<object|null>}
   */
  async findById(id, client = null) {
    const runner = client || this;
    try {
      const sql = `
        SELECT st.*, b.booking_reference, b.booking_number
        FROM support_tickets st
        LEFT JOIN bookings b ON b.id = st.booking_id
        WHERE st.id = $1
      `;
      const res = await runner.query(sql, [id]);
      return res.rows[0] ? SupportTicketRepository.mapDto(res.rows[0]) : null;
    } catch (err) {
      if (err.message && (err.message.includes('booking_reference') || err.message.includes('booking_number'))) {
        const sql = `
          SELECT st.*, NULL AS booking_reference, NULL AS booking_number
          FROM support_tickets st
          WHERE st.id = $1
        `;
        const res = await runner.query(sql, [id]);
        return res.rows[0] ? SupportTicketRepository.mapDto(res.rows[0]) : null;
      }
      throw err;
    }
  }

  /**
   * Finds a support ticket by id and customerId for ownership checks.
   *
   * @param {string} id
   * @param {string} customerId
   * @param {object} [client]
   * @returns {Promise<object|null>}
   */
  async findByIdAndCustomerId(id, customerId, client = null) {
    const runner = client || this;
    try {
      const sql = `
        SELECT st.*, b.booking_reference, b.booking_number
        FROM support_tickets st
        LEFT JOIN bookings b ON b.id = st.booking_id
        WHERE st.id = $1 AND (st.user_id = $2 OR st.customer_id = $2)
      `;
      const res = await runner.query(sql, [id, customerId]);
      return res.rows[0] ? SupportTicketRepository.mapDto(res.rows[0]) : null;
    } catch (err) {
      if (err.message && (err.message.includes('user_id') || err.message.includes('does not exist'))) {
        const sql = `
          SELECT st.*, b.booking_reference, b.booking_number
          FROM support_tickets st
          LEFT JOIN bookings b ON b.id = st.booking_id
          WHERE st.id = $1 AND st.customer_id = $2
        `;
        const res = await runner.query(sql, [id, customerId]);
        return res.rows[0] ? SupportTicketRepository.mapDto(res.rows[0]) : null;
      }
      throw err;
    }
  }

  /**
   * Lists tickets belonging to a customer with pagination and optional filters.
   *
   * @param {string} customerId
   * @param {object} query
   * @param {number} [query.page=1]
   * @param {number} [query.limit=20]
   * @param {string} [query.status]
   * @param {string} [query.category]
   * @param {object} [client]
   * @returns {Promise<{data: object[], pagination: object}>}
   */
  async findByCustomerId(
    customerId,
    { page = 1, limit = 20, status, category } = {},
    client = null,
  ) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    const runner = client || this;
    const executeQuery = async (idCondition) => {
      const conditions = [idCondition];
      const params = [customerId];
      let paramIndex = 2;

      if (status && status !== 'ALL') {
        conditions.push(`UPPER(st.status::text) = $${paramIndex}`);
        params.push(status.toUpperCase().trim());
        paramIndex += 1;
      }

      if (category && category !== 'ALL') {
        conditions.push(`UPPER(st.category::text) = $${paramIndex}`);
        params.push(category.toUpperCase().trim());
        paramIndex += 1;
      }

      const whereClause = conditions.join(' AND ');

      const countSql = `SELECT COUNT(*) AS count FROM support_tickets st WHERE ${whereClause}`;
      const dataSql = `
        SELECT st.*, b.booking_reference, b.booking_number
        FROM support_tickets st
        LEFT JOIN bookings b ON b.id = st.booking_id
        WHERE ${whereClause}
        ORDER BY st.created_at DESC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;

      const countRes = await runner.query(countSql, params);
      const total = parseInt(countRes.rows[0]?.count || 0, 10);

      const dataRes = await runner.query(dataSql, [...params, limitNum, offset]);
      const tickets = dataRes.rows.map(SupportTicketRepository.mapDto);

      return {
        data: tickets,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          totalPages: Math.ceil(total / limitNum) || 1,
        },
      };
    };

    try {
      return await executeQuery('(st.user_id = $1 OR st.customer_id = $1)');
    } catch (err) {
      if (err.message && (err.message.includes('user_id') || err.message.includes('does not exist'))) {
        return await executeQuery('st.customer_id = $1');
      }
      throw err;
    }
  }

  /**
   * Updates status of a ticket and relevant timestamps.
   *
   * @param {string} id
   * @param {string} status
   * @param {object} [timestamps]
   * @param {string|Date} [timestamps.resolvedAt]
   * @param {string|Date} [timestamps.closedAt]
   * @param {object} [client]
   * @returns {Promise<object|null>}
   */
  async updateStatus(id, status, { resolvedAt = null, closedAt = null } = {}, client = null) {
    const updates = ['status = $2', 'updated_at = CURRENT_TIMESTAMP'];
    const params = [id, status.toUpperCase()];
    let paramIndex = 3;

    if (resolvedAt !== undefined) {
      updates.push(`resolved_at = $${paramIndex}`);
      params.push(resolvedAt);
      paramIndex += 1;
    }

    if (closedAt !== undefined) {
      updates.push(`closed_at = $${paramIndex}`);
      params.push(closedAt);
      paramIndex += 1;
    }

    const sql = `
      UPDATE support_tickets
      SET ${updates.join(', ')}
      WHERE id = $1
      RETURNING *
    `;

    const runner = client || this;
    const res = await runner.query(sql, params);
    return SupportTicketRepository.mapDto(res.rows[0]);
  }
}

module.exports = SupportTicketRepository;
