'use strict';

const BaseRepository = require('../db/base.repository');
const { escapeLikeString } = require('../db/sql-helpers');

let mockSupportResolver = null;

class AdminSupportRepository extends BaseRepository {
  constructor() {
    super('support_tickets', 'id');
  }

  /**
   * For unit testing: inject mock resolver
   * @param {object|Function|null} resolver
   */
  static setMockSupportResolver(resolver) {
    mockSupportResolver = resolver;
  }

  static resetMockSupportResolver() {
    mockSupportResolver = null;
  }

  /**
   * Returns query executor (client or pool query).
   * @private
   */
  _getExecutor(client) {
    if (mockSupportResolver) {
      return (text, params) => {
        if (typeof mockSupportResolver === 'function') {
          return mockSupportResolver(text, params);
        }
        if (typeof mockSupportResolver.query === 'function') {
          return mockSupportResolver.query(text, params);
        }
        return Promise.resolve({ rows: [] });
      };
    }
    return (client && typeof client.query === 'function')
      ? (text, params) => client.query(text, params)
      : (text, params) => this.query(text, params);
  }

  /**
   * Lists support tickets with rich filtering, search, pagination, and sorting.
   */
  async listTickets({
    search = null,
    status = null,
    priority = null,
    category = null,
    assignedTo = null,
    customerId = null,
    partnerId = null,
    bookingId = null,
    startDate = null,
    endDate = null,
    updatedStartDate = null,
    updatedEndDate = null,
    limit = 20,
    offset = 0,
    sortBy = 'created_at',
    sortOrder = 'DESC',
  } = {}, client = null) {
    const executor = this._getExecutor(client);
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (search && search.trim() !== '') {
      const escaped = `%${escapeLikeString(search.trim())}%`;
      conditions.push(`(
        t.ticket_number ILIKE $${paramIndex}
        OR t.subject ILIKE $${paramIndex}
        OR cu.name ILIKE $${paramIndex}
        OR cu.phone ILIKE $${paramIndex}
        OR cu.email ILIKE $${paramIndex}
        OR pt.business_name ILIKE $${paramIndex}
        OR pu.name ILIKE $${paramIndex}
        OR pu.phone ILIKE $${paramIndex}
        OR b.booking_number ILIKE $${paramIndex}
      )`);
      params.push(escaped);
      paramIndex += 1;
    }

    if (status) {
      conditions.push(`t.status = $${paramIndex}`);
      params.push(status);
      paramIndex += 1;
    }

    if (priority) {
      conditions.push(`t.priority = $${paramIndex}`);
      params.push(priority);
      paramIndex += 1;
    }

    if (category) {
      conditions.push(`t.category = $${paramIndex}`);
      params.push(category);
      paramIndex += 1;
    }

    if (assignedTo) {
      conditions.push(`t.assigned_to = $${paramIndex}`);
      params.push(assignedTo);
      paramIndex += 1;
    }

    if (customerId) {
      conditions.push(`t.customer_id = $${paramIndex}`);
      params.push(customerId);
      paramIndex += 1;
    }

    if (partnerId) {
      conditions.push(`t.partner_id = $${paramIndex}`);
      params.push(partnerId);
      paramIndex += 1;
    }

    if (bookingId) {
      conditions.push(`t.booking_id = $${paramIndex}`);
      params.push(bookingId);
      paramIndex += 1;
    }

    if (startDate) {
      conditions.push(`t.created_at >= $${paramIndex}`);
      params.push(startDate);
      paramIndex += 1;
    }

    if (endDate) {
      conditions.push(`t.created_at <= $${paramIndex}`);
      params.push(endDate);
      paramIndex += 1;
    }

    if (updatedStartDate) {
      conditions.push(`t.updated_at >= $${paramIndex}`);
      params.push(updatedStartDate);
      paramIndex += 1;
    }

    if (updatedEndDate) {
      conditions.push(`t.updated_at <= $${paramIndex}`);
      params.push(updatedEndDate);
      paramIndex += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const allowedSortColumns = {
      created_at: 't.created_at',
      updated_at: 't.updated_at',
      priority: 't.priority',
      status: 't.status',
      category: 't.category',
      ticket_number: 't.ticket_number',
    };
    const sortColumn = allowedSortColumns[sortBy.toLowerCase()] || 't.created_at';
    const direction = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM support_tickets t
      LEFT JOIN users cu ON cu.id = t.customer_id
      LEFT JOIN partners pt ON pt.id = t.partner_id
      LEFT JOIN users pu ON pu.id = pt.user_id
      LEFT JOIN bookings b ON b.id = t.booking_id
      ${whereClause};
    `;

    const dataQuery = `
      SELECT
        t.id,
        t.ticket_number,
        t.customer_id,
        t.partner_id,
        t.booking_id,
        t.category,
        t.subject,
        t.description,
        t.status,
        t.priority,
        t.assigned_to,
        t.assigned_at,
        t.resolved_by,
        t.resolved_at,
        t.closed_at,
        t.resolution_notes,
        t.metadata,
        t.created_at,
        t.updated_at,
        -- Customer summary
        cu.name AS customer_name,
        cu.phone AS customer_phone,
        cu.email AS customer_email,
        -- Partner summary
        pt.business_name AS partner_business_name,
        pu.name AS partner_owner_name,
        pu.phone AS partner_phone,
        -- Booking summary
        b.booking_number,
        b.booking_status,
        -- Admin assignment
        au.name AS assigned_admin_name,
        au.email AS assigned_admin_email,
        -- Resolver summary
        ru.name AS resolved_by_admin_name,
        -- Counts
        COALESCE(msg_stats.message_count, 0)::int AS message_count,
        msg_stats.last_message_at,
        -- Earliest original message raiser resolution
        orig_msg.sender_type AS original_sender_type,
        orig_msg.sender_id AS original_sender_id,
        orig_msg.created_at AS original_message_at
      FROM support_tickets t
      LEFT JOIN users cu ON cu.id = t.customer_id
      LEFT JOIN partners pt ON pt.id = t.partner_id
      LEFT JOIN users pu ON pu.id = pt.user_id
      LEFT JOIN bookings b ON b.id = t.booking_id
      LEFT JOIN users au ON au.id = t.assigned_to
      LEFT JOIN users ru ON ru.id = t.resolved_by
      LEFT JOIN (
        SELECT
          ticket_id,
          COUNT(id)::int AS message_count,
          MAX(created_at) AS last_message_at
        FROM support_ticket_messages
        GROUP BY ticket_id
      ) msg_stats ON msg_stats.ticket_id = t.id
      LEFT JOIN (
        SELECT DISTINCT ON (ticket_id)
          ticket_id,
          sender_type,
          sender_id,
          created_at
        FROM support_ticket_messages
        ORDER BY ticket_id, created_at ASC, id ASC
      ) orig_msg ON orig_msg.ticket_id = t.id
      ${whereClause}
      ORDER BY ${sortColumn} ${direction}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1};
    `;

    const countRes = await executor(countQuery, params);
    const total = countRes.rows[0]?.total || 0;

    const dataParams = [...params, limit, offset];
    const dataRes = await executor(dataQuery, dataParams);

    return {
      tickets: dataRes.rows,
      total,
    };
  }

  /**
   * Retrieves complete ticket details with all relationships and message summaries.
   */
  async getTicketById(id, client = null) {
    const executor = this._getExecutor(client);
    const query = `
      SELECT
        t.id,
        t.ticket_number,
        t.customer_id,
        t.partner_id,
        t.booking_id,
        t.category,
        t.subject,
        t.description,
        t.status,
        t.priority,
        t.assigned_to,
        t.assigned_at,
        t.resolved_by,
        t.resolved_at,
        t.closed_at,
        t.resolution_notes,
        t.metadata,
        t.created_at,
        t.updated_at,
        -- Customer
        cu.name AS customer_name,
        cu.phone AS customer_phone,
        cu.email AS customer_email,
        cu.is_active AS customer_is_active,
        -- Partner
        pt.business_name AS partner_business_name,
        pt.city AS partner_city,
        pt.kyc_status AS partner_kyc_status,
        pu.id AS partner_user_id,
        pu.name AS partner_owner_name,
        pu.phone AS partner_phone,
        pu.email AS partner_email,
        -- Booking
        b.booking_number,
        b.booking_status,
        b.payment_status AS booking_payment_status,
        b.start_at AS booking_start_date,
        b.end_at AS booking_end_date,
        b.total_amount AS booking_total_amount,
        b.vehicle_id AS booking_vehicle_id,
        -- Vehicle (if linked via booking)
        v.id AS vehicle_id,
        v.brand AS vehicle_make,
        v.model AS vehicle_model,
        v.registration_number AS vehicle_registration_number,
        v.category AS vehicle_category,
        -- Admin
        au.name AS assigned_admin_name,
        au.email AS assigned_admin_email,
        -- Resolver
        ru.name AS resolved_by_admin_name,
        ru.email AS resolved_by_admin_email,
        -- Message count
        COALESCE(msg_stats.message_count, 0)::int AS message_count,
        msg_stats.last_message_at,
        -- Earliest original message raiser resolution
        orig_msg.sender_type AS original_sender_type,
        orig_msg.sender_id AS original_sender_id,
        orig_msg.created_at AS original_message_at
      FROM support_tickets t
      LEFT JOIN users cu ON cu.id = t.customer_id
      LEFT JOIN partners pt ON pt.id = t.partner_id
      LEFT JOIN users pu ON pu.id = pt.user_id
      LEFT JOIN bookings b ON b.id = t.booking_id
      LEFT JOIN vehicles v ON v.id = b.vehicle_id
      LEFT JOIN users au ON au.id = t.assigned_to
      LEFT JOIN users ru ON ru.id = t.resolved_by
      LEFT JOIN (
        SELECT
          ticket_id,
          COUNT(id)::int AS message_count,
          MAX(created_at) AS last_message_at
        FROM support_ticket_messages
        GROUP BY ticket_id
      ) msg_stats ON msg_stats.ticket_id = t.id
      LEFT JOIN (
        SELECT DISTINCT ON (ticket_id)
          ticket_id,
          sender_type,
          sender_id,
          created_at
        FROM support_ticket_messages
        ORDER BY ticket_id, created_at ASC, id ASC
      ) orig_msg ON orig_msg.ticket_id = t.id
      WHERE (t.id::text = $1 OR t.ticket_number = $1)
      LIMIT 1;
    `;

    const res = await executor(query, [id]);
    return res.rows[0] || null;
  }

  /**
   * Locks and retrieves a ticket row for state mutations (FOR UPDATE).
   */
  async getTicketForUpdate(client, id) {
    const executor = this._getExecutor(client);
    const sql = `
      SELECT *
      FROM support_tickets
      WHERE (id::text = $1 OR ticket_number = $1)
      FOR UPDATE;
    `;
    const res = await executor(sql, [id]);
    return res.rows[0] || null;
  }

  /**
   * Retrieves messages for a ticket ordered chronologically.
   */
  async getTicketMessages(ticketId, client = null) {
    const executor = this._getExecutor(client);
    const sql = `
      SELECT
        m.id,
        m.ticket_id,
        m.sender_type,
        m.sender_id,
        m.message,
        m.attachments,
        m.created_at,
        COALESCE(u.name, pt.business_name, pu.name) AS sender_name,
        COALESCE(u.role, 'PARTNER') AS sender_role,
        COALESCE(u.email, pu.email) AS sender_email
      FROM support_ticket_messages m
      LEFT JOIN support_tickets t ON t.id = m.ticket_id
      LEFT JOIN users u ON u.id = m.sender_id
      LEFT JOIN partners pt ON pt.id = m.sender_id
      LEFT JOIN users pu ON pu.id = pt.user_id
      WHERE (m.ticket_id::text = $1 OR t.ticket_number = $1)
      ORDER BY m.created_at ASC, m.id ASC;
    `;
    const res = await executor(sql, [ticketId]);
    return res.rows;
  }

  /**
   * Appends an admin message to a support ticket.
   */
  async createMessage(client, {
    ticketId,
    senderType = 'ADMIN',
    senderId,
    message,
    attachments = [],
  }) {
    const executor = this._getExecutor(client);
    const sql = `
      INSERT INTO support_ticket_messages (
        ticket_id, sender_type, sender_id, message, attachments, created_at
      )
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
      RETURNING *;
    `;

    // attachments in support_messages is JSONB
    const res = await executor(sql, [
      ticketId,
      senderType,
      senderId,
      message,
      JSON.stringify(Array.isArray(attachments) ? attachments : []),
    ]);
    return res.rows[0];
  }

  /**
   * Updates ticket fields (status, priority, category, assigned_to, etc.).
   */
  async updateTicket(client, id, updates = {}) {
    const executor = this._getExecutor(client);
    const fields = [];
    const values = [];
    let paramIndex = 1;

    Object.keys(updates).forEach((key) => {
      if (updates[key] !== undefined) {
        fields.push(`${key} = $${paramIndex}`);
        values.push(updates[key]);
        paramIndex += 1;
      }
    });

    if (fields.length === 0) {
      return this.findById(id, client);
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const sql = `
      UPDATE support_tickets
      SET ${fields.join(', ')}
      WHERE (id::text = $${paramIndex} OR ticket_number = $${paramIndex})
      RETURNING *;
    `;

    const res = await executor(sql, values);
    return res.rows[0] || null;
  }

  /**
   * Resolves canonical Customer user information for ticket ownership view.
   */
  async getTicketCustomer(ticketId, client = null) {
    const executor = this._getExecutor(client);
    const sql = `
      SELECT
        u.id,
        u.name,
        u.phone,
        u.email,
        u.role,
        u.is_active,
        u.created_at,
        -- aggregate stats
        (SELECT COUNT(*)::int FROM bookings b WHERE b.customer_id = u.id) AS total_bookings,
        (SELECT COUNT(*)::int FROM support_tickets st WHERE st.customer_id = u.id) AS total_tickets
      FROM support_tickets t
      JOIN users u ON u.id = t.customer_id
      WHERE t.id = $1
      LIMIT 1;
    `;
    const res = await executor(sql, [ticketId]);
    return res.rows[0] || null;
  }

  /**
   * Resolves canonical Partner user and business information for ticket ownership view.
   */
  async getTicketPartner(ticketId, client = null) {
    const executor = this._getExecutor(client);
    const sql = `
      SELECT
        p.id,
        p.user_id,
        p.business_name,
        p.business_address,
        p.city,
        p.partner_status,
        p.kyc_status,
        p.created_at,
        u.name AS owner_name,
        u.phone AS owner_phone,
        u.email AS owner_email,
        u.is_active AS owner_is_active,
        (SELECT COUNT(*)::int FROM vehicles v WHERE v.partner_id = p.id AND v.is_active = true) AS active_vehicles,
        (SELECT COUNT(*)::int FROM bookings b WHERE b.partner_id = p.id) AS total_bookings,
        (SELECT COUNT(*)::int FROM support_tickets st WHERE st.partner_id = p.id) AS total_tickets
      FROM support_tickets t
      JOIN partners p ON p.id = t.partner_id
      JOIN users u ON u.id = p.user_id
      WHERE t.id = $1
      LIMIT 1;
    `;
    const res = await executor(sql, [ticketId]);
    return res.rows[0] || null;
  }

  /**
   * Resolves canonical Booking details for ticket linkage view.
   */
  async getTicketBooking(ticketId, client = null) {
    const executor = this._getExecutor(client);
    const sql = `
      SELECT
        b.id,
        b.booking_number,
        b.customer_id,
        b.partner_id,
        b.vehicle_id,
        b.booking_status,
        b.payment_status,
        b.start_at AS start_date,
        b.end_at AS end_date,
        b.subtotal AS base_fare,
        b.total_amount,
        b.created_at,
        -- Customer
        cu.name AS customer_name,
        cu.phone AS customer_phone,
        cu.email AS customer_email,
        -- Partner
        pt.business_name AS partner_business_name,
        pu.name AS partner_owner_name,
        pu.phone AS partner_phone,
        -- Vehicle
        v.brand AS vehicle_make,
        v.model AS vehicle_model,
        v.registration_number AS vehicle_registration_number,
        v.category AS vehicle_category
      FROM support_tickets t
      JOIN bookings b ON b.id = t.booking_id
      LEFT JOIN users cu ON cu.id = b.customer_id
      LEFT JOIN partners pt ON pt.id = b.partner_id
      LEFT JOIN users pu ON pu.id = pt.user_id
      LEFT JOIN vehicles v ON v.id = b.vehicle_id
      WHERE t.id = $1
      LIMIT 1;
    `;
    const res = await executor(sql, [ticketId]);
    return res.rows[0] || null;
  }

  /**
   * Resolves active ADMIN user for assignment verification.
   */
  async getActiveAdminUser(userId, client = null) {
    const executor = this._getExecutor(client);
    const sql = `
      SELECT id, name, email, phone, role, is_active
      FROM users
      WHERE id = $1
      LIMIT 1;
    `;
    const res = await executor(sql, [userId]);
    return res.rows[0] || null;
  }

  /**
   * Resolves an active admin user record by email, auth_id, or gets a default active admin.
   */
  async findFallbackAdminUser(emailOrAuthId = null, client = null) {
    const executor = this._getExecutor(client);
    if (emailOrAuthId) {
      const sql = `
        SELECT id, name, email, role, is_active
        FROM users
        WHERE (email = $1 OR auth_id = $1)
          AND role IN ('ADMIN', 'admin', 'super_admin', 'support_executive')
          AND is_active = true
        LIMIT 1;
      `;
      const res = await executor(sql, [emailOrAuthId]);
      if (res.rows[0]) return res.rows[0];
    }

    const fallbackSql = `
      SELECT id, name, email, role, is_active
      FROM users
      WHERE role IN ('ADMIN', 'admin', 'super_admin', 'support_executive')
        AND is_active = true
      ORDER BY created_at ASC
      LIMIT 1;
    `;
    const res = await executor(fallbackSql);
    return res.rows[0] || null;
  }

  /**
   * Resolves audit trail timeline for a support ticket.
   */
  async getTicketAuditLogs(ticketId, client = null) {
    const executor = this._getExecutor(client);
    const sql = `
      SELECT
        a.id,
        a.actor_id,
        a.actor_role,
        a.permission,
        a.action,
        a.target_resource,
        a.target_resource_id,
        a.before_state,
        a.after_state,
        a.metadata,
        a.created_at,
        u.name AS actor_name,
        u.email AS actor_email
      FROM admin_actions a
      LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.target_resource = 'SUPPORT_TICKET'
        AND a.target_resource_id = $1
      ORDER BY a.created_at ASC;
    `;
    const res = await executor(sql, [ticketId]);
    return res.rows;
  }

  async recordStatusHistory(client, { ticketId, oldStatus, newStatus, changedBy, reason = null }) {
    const executor = this._getExecutor(client);
    try {
      const sql = `
        INSERT INTO ticket_status_history (ticket_id, old_status, new_status, changed_by, reason)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *;
      `;
      const res = await executor(sql, [ticketId, oldStatus, newStatus, changedBy, reason]);
      return res.rows[0] || null;
    } catch (_) {
      return null;
    }
  }
}

module.exports = AdminSupportRepository;
