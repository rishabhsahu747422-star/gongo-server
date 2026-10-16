'use strict';

const BaseRepository = require('../db/base.repository');
const pool = require('../db/pool');
const { isValidUuid } = require('../validators');

class SupportTicketRepository extends BaseRepository {
  constructor() {
    super('support_tickets', 'id');
  }

  /**
   * Atomically creates a support ticket along with its initial partner message.
   *
   * @param {object} params
   * @param {string} params.partnerId
   * @param {string} params.ticketNumber
   * @param {string} params.category
   * @param {string} params.subject
   * @param {string} params.priority
   * @param {string} params.message
   * @param {string[]} params.attachments
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>} Created ticket and initial message
   */
  async createTicketWithInitialMessage(params, client = null) {
    const execute = async (c) => {
      // 1. Insert support ticket
      const ticketSql = `
        INSERT INTO ${this.tableName} (
          partner_id, user_id, ticket_number, category, subject, description, status, priority, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', $7, '{}'::jsonb)
        RETURNING *;
      `;
      const ticketRes = await c.query(ticketSql, [
        params.partnerId,
        params.userId,
        params.ticketNumber,
        params.category,
        params.subject,
        params.description || params.message,
        params.priority,
      ]);
      const ticket = ticketRes.rows[0];

      // 2. Insert initial message
      const senderId = (params.userId && isValidUuid(params.userId))
        ? params.userId
        : (params.partnerId && isValidUuid(params.partnerId) ? params.partnerId : null);

      const msgSql = `
        INSERT INTO support_ticket_messages (
          ticket_id, sender_type, sender_id, message, attachments
        )
        VALUES ($1, 'PARTNER', $2, $3, $4)
        RETURNING *;
      `;
      const msgRes = await c.query(msgSql, [
        ticket.id,
        senderId,
        params.message,
        params.attachments && params.attachments.length > 0
          ? JSON.stringify(params.attachments)
          : null,
      ]);
      const initialMessage = msgRes.rows[0];

      return {
        ...ticket,
        messages: [initialMessage],
      };
    };

    if (client) {
      return execute(client);
    }
    return pool.transaction((txClient) => execute(txClient));
  }

  /**
   * Lists paginated tickets for a partner with optional status/priority/category filters.
   *
   * @param {string} partnerId
   * @param {object} options
   * @returns {Promise<{ rows: object[], total: number }>}
   */
  async findTicketsByPartnerId(partnerId, options = {}) {
    const {
      status,
      priority,
      category,
      limit = 20,
      offset = 0,
    } = options;

    const whereClauses = ['t.partner_id = $1'];
    const queryParams = [partnerId];
    let paramIndex = 2;

    if (status) {
      whereClauses.push(`t.status = $${paramIndex}`);
      queryParams.push(status);
      paramIndex += 1;
    }

    if (priority) {
      whereClauses.push(`t.priority = $${paramIndex}`);
      queryParams.push(priority);
      paramIndex += 1;
    }

    if (category) {
      whereClauses.push(`t.category = $${paramIndex}`);
      queryParams.push(category);
      paramIndex += 1;
    }

    const whereSql = whereClauses.join(' AND ');

    // 1. Total count
    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM ${this.tableName} t
      WHERE ${whereSql};
    `;
    const countRes = await this.query(countSql, queryParams);
    const total = countRes.rows[0]?.total || 0;

    // 2. Data rows
    const dataSql = `
      SELECT
        t.*,
        COUNT(m.id)::int AS message_count,
        MAX(m.created_at) AS last_message_at
      FROM ${this.tableName} t
      LEFT JOIN support_ticket_messages m ON m.ticket_id = t.id
      WHERE ${whereSql}
      GROUP BY t.id
      ORDER BY t.updated_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1};
    `;
    const dataParams = [...queryParams, limit, offset];
    const dataRes = await this.query(dataSql, dataParams);

    return {
      rows: dataRes.rows,
      total,
    };
  }

  /**
   * Retrieves a ticket and all messages for a specific partner (strict BOLA).
   *
   * @param {string} ticketId
   * @param {string} partnerId
   * @returns {Promise<object|null>} Ticket with messages array or null
   */
  async findTicketByIdAndPartnerId(ticketId, partnerId) {
    const ticketSql = `
      SELECT *
      FROM ${this.tableName}
      WHERE (id::text = $1 OR ticket_number = $1) AND partner_id = $2
      LIMIT 1;
    `;
    const ticketRes = await this.query(ticketSql, [ticketId, partnerId]);
    if (!ticketRes.rows[0]) return null;

    const ticket = ticketRes.rows[0];

    const messagesSql = `
      SELECT *
      FROM support_ticket_messages
      WHERE ticket_id = $1
      ORDER BY created_at ASC;
    `;
    const msgRes = await this.query(messagesSql, [ticket.id]);
    ticket.messages = msgRes.rows;

    return ticket;
  }

  /**
   * Adds a message to a ticket and touches updated_at.
   *
   * @param {object} params
   * @param {string} params.ticketId
   * @param {'PARTNER'|'SUPPORT'|'SYSTEM'} params.senderType
   * @param {string} params.senderId
   * @param {string} params.message
   * @param {string[]} [params.attachments]
   * @param {string} [params.reopenStatus]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>} Created message
   */
  async addMessage(params, client = null) {
    const execute = async (c) => {
      const msgSql = `
        INSERT INTO support_ticket_messages (
          ticket_id, sender_type, sender_id, message, attachments
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *;
      `;
      let senderId = (params.senderId && isValidUuid(params.senderId)) ? params.senderId : null;
      if (!senderId) {
        const ticketOwnerRes = await c.query(
          `SELECT user_id, partner_id FROM ${this.tableName} WHERE id = $1`,
          [params.ticketId],
        );
        if (ticketOwnerRes.rows[0]) {
          senderId = ticketOwnerRes.rows[0].user_id || ticketOwnerRes.rows[0].partner_id;
        }
      }

      const msgRes = await c.query(msgSql, [
        params.ticketId,
        params.senderType,
        senderId,
        params.message,
        params.attachments && params.attachments.length > 0
          ? JSON.stringify(params.attachments)
          : null,
      ]);

      // Touch ticket updated_at and optionally reopen if closed
      const updateTicketSql = params.reopenStatus
        ? `UPDATE ${this.tableName} SET updated_at = CURRENT_TIMESTAMP, status = $2 WHERE id = $1`
        : `UPDATE ${this.tableName} SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`;

      const updateParams = params.reopenStatus
        ? [params.ticketId, params.reopenStatus]
        : [params.ticketId];

      await c.query(updateTicketSql, updateParams);

      return msgRes.rows[0];
    };

    if (client) {
      return execute(client);
    }
    return pool.transaction((txClient) => execute(txClient));
  }

  /**
   * Updates status and/or priority for a ticket (admin).
   *
   * @param {string} ticketId
   * @param {object} updates
   * @param {string} [updates.status]
   * @param {string} [updates.priority]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async updateTicketStatus(ticketId, updates, client = null) {
    const fields = [];
    const values = [];
    let idx = 1;

    if (updates.status !== undefined) {
      fields.push(`status = $${idx}`);
      values.push(updates.status);
      idx += 1;
    }

    if (updates.priority !== undefined) {
      fields.push(`priority = $${idx}`);
      values.push(updates.priority);
      idx += 1;
    }

    if (fields.length === 0) {
      return this.findById(ticketId, client);
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(ticketId);

    const text = `
      UPDATE ${this.tableName}
      SET ${fields.join(', ')}
      WHERE id = $${idx}
      RETURNING *;
    `;

    const res = client ? await client.query(text, values) : await this.query(text, values);
    return res.rows[0] || null;
  }

  /**
   * Admin: List all tickets across all partners with joined partner context.
   *
   * @param {object} options
   * @returns {Promise<{ rows: object[], total: number }>}
   */
  async findAllTicketsAdmin(options = {}) {
    const {
      status,
      priority,
      category,
      partnerId,
      search,
      limit = 20,
      offset = 0,
    } = options;

    const whereClauses = [];
    const queryParams = [];
    let paramIndex = 1;

    if (status) {
      whereClauses.push(`t.status = $${paramIndex}`);
      queryParams.push(status);
      paramIndex += 1;
    }

    if (priority) {
      whereClauses.push(`t.priority = $${paramIndex}`);
      queryParams.push(priority);
      paramIndex += 1;
    }

    if (category) {
      whereClauses.push(`t.category = $${paramIndex}`);
      queryParams.push(category);
      paramIndex += 1;
    }

    if (partnerId) {
      whereClauses.push(`t.partner_id = $${paramIndex}`);
      queryParams.push(partnerId);
      paramIndex += 1;
    }

    if (search && search.trim()) {
      const term = `%${search.trim()}%`;
      whereClauses.push(`(
        t.ticket_number ILIKE $${paramIndex} OR
        t.subject ILIKE $${paramIndex} OR
        t.description ILIKE $${paramIndex} OR
        p.business_name ILIKE $${paramIndex} OR
        u.name ILIKE $${paramIndex} OR
        u.phone ILIKE $${paramIndex}
      )`);
      queryParams.push(term);
      paramIndex += 1;
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM ${this.tableName} t
      LEFT JOIN partners p ON p.id = t.partner_id
      LEFT JOIN users u ON u.id = p.user_id
      ${whereSql};
    `;
    const countRes = await this.query(countSql, queryParams);
    const total = countRes.rows[0]?.total || 0;

    const dataSql = `
      SELECT
        t.*,
        p.business_name,
        u.name AS partner_name,
        u.phone AS partner_phone,
        u.email AS partner_email,
        COUNT(m.id)::int AS message_count,
        MAX(m.created_at) AS last_message_at
      FROM ${this.tableName} t
      LEFT JOIN partners p ON p.id = t.partner_id
      LEFT JOIN users u ON u.id = p.user_id
      LEFT JOIN support_ticket_messages m ON m.ticket_id = t.id
      ${whereSql}
      GROUP BY t.id, p.business_name, u.name, u.phone, u.email
      ORDER BY t.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1};
    `;
    const dataParams = [...queryParams, limit, offset];
    const dataRes = await this.query(dataSql, dataParams);

    return {
      rows: dataRes.rows,
      total,
    };
  }

  /**
   * Admin: Get ticket details by ID with partner context and all messages.
   *
   * @param {string} ticketId
   * @returns {Promise<object|null>}
   */
  async findTicketByIdAdmin(ticketId) {
    const ticketSql = `
      SELECT
        t.*,
        p.business_name,
        u.name AS partner_name,
        u.phone AS partner_phone,
        u.email AS partner_email
      FROM ${this.tableName} t
      LEFT JOIN partners p ON p.id = t.partner_id
      LEFT JOIN users u ON u.id = p.user_id
      WHERE t.id = $1
      LIMIT 1;
    `;
    const ticketRes = await this.query(ticketSql, [ticketId]);
    if (!ticketRes.rows[0]) return null;

    const ticket = ticketRes.rows[0];

    const messagesSql = `
      SELECT *
      FROM support_ticket_messages
      WHERE ticket_id = $1
      ORDER BY created_at ASC;
    `;
    const msgRes = await this.query(messagesSql, [ticketId]);
    ticket.messages = msgRes.rows;

    return ticket;
  }
}

module.exports = SupportTicketRepository;
