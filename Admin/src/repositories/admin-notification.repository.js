'use strict';

const BaseRepository = require('../db/base.repository');
const { escapeLikeString } = require('../db/sql-helpers');

const ALLOWED_SORT_COLUMNS = new Set([
  'created_at',
  'updated_at',
  'status',
  'type',
  'title',
  'channel',
]);

const ALLOWED_TEMPLATE_SORT_COLUMNS = new Set([
  'created_at',
  'updated_at',
  'title',
  'template_key',
  'notification_type',
  'channel',
  'is_active',
]);

class AdminNotificationRepository extends BaseRepository {
  constructor() {
    super('notifications', 'id');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 1. Notification Queries & Listings
  // ══════════════════════════════════════════════════════════════════════════════

  /**
   * Retrieves paginated notifications with dynamic parameterized filters.
   *
   * @param {object} options
   * @returns {Promise<{ items: object[], pagination: object }>}
   */
  async listNotifications(options = {}) {
    const page = Math.max(1, parseInt(options.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(options.limit, 10) || 20));
    const offset = (page - 1) * limit;

    const whereClauses = [];
    const values = [];
    let paramIndex = 1;

    // Search query over title or body
    if (options.search && typeof options.search === 'string' && options.search.trim()) {
      const escaped = `%${escapeLikeString(options.search.trim())}%`;
      whereClauses.push(`(n.title ILIKE $${paramIndex} OR n.body ILIKE $${paramIndex})`);
      values.push(escaped);
      paramIndex += 1;
    }

    // Recipient filter
    if (options.recipientId && typeof options.recipientId === 'string' && options.recipientId.trim()) {
      whereClauses.push(`(n.customer_id = $${paramIndex} OR n.partner_id = $${paramIndex})`);
      values.push(options.recipientId.trim());
      paramIndex += 1;
    }

    // Recipient type filter
    if (options.recipientType && typeof options.recipientType === 'string' && options.recipientType.trim()) {
      whereClauses.push(`n.recipient_type = $${paramIndex}`);
      values.push(options.recipientType.trim().toUpperCase());
      paramIndex += 1;
    }

    // Type filter
    if (options.type && typeof options.type === 'string' && options.type.trim()) {
      whereClauses.push(`n.type = $${paramIndex}`);
      values.push(options.type.trim().toUpperCase());
      paramIndex += 1;
    }

    // Channel filter
    if (options.channel && typeof options.channel === 'string' && options.channel.trim()) {
      whereClauses.push(`n.channel = $${paramIndex}`);
      values.push(options.channel.trim().toUpperCase());
      paramIndex += 1;
    }

    // Status filter
    if (options.status && typeof options.status === 'string' && options.status.trim()) {
      whereClauses.push(`n.status = $${paramIndex}`);
      values.push(options.status.trim().toUpperCase());
      paramIndex += 1;
    }

    // Template filter
    if (options.templateId && typeof options.templateId === 'string' && options.templateId.trim()) {
      whereClauses.push(`n.template_id = $${paramIndex}`);
      values.push(options.templateId.trim());
      paramIndex += 1;
    }

    // Booking filter
    if (options.bookingId && typeof options.bookingId === 'string' && options.bookingId.trim()) {
      whereClauses.push(`n.booking_id = $${paramIndex}`);
      values.push(options.bookingId.trim());
      paramIndex += 1;
    }

    // Date range filters
    if (options.startDate) {
      whereClauses.push(`n.created_at >= $${paramIndex}`);
      values.push(new Date(options.startDate).toISOString());
      paramIndex += 1;
    }
    if (options.endDate) {
      whereClauses.push(`n.created_at <= $${paramIndex}`);
      values.push(new Date(options.endDate).toISOString());
      paramIndex += 1;
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Safe sorting
    const requestedSort = (options.sortBy || 'created_at').toLowerCase();
    const sortColumn = ALLOWED_SORT_COLUMNS.has(requestedSort) ? `n.${requestedSort}` : 'n.created_at';
    const sortOrder = (options.sortOrder || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Count query
    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM notifications n
      ${whereSql};
    `;
    const countRes = await this.query(countSql, values);
    const total = parseInt(countRes.rows[0]?.total || 0, 10);

    // Items query with projection
    const itemsSql = `
      SELECT
        n.id,
        n.customer_id,
        n.partner_id,
        n.recipient_type,
        n.type,
        n.title,
        n.body,
        n.channel,
        n.status,
        n.template_id,
        n.booking_id,
        n.sent_by,
        n.read_at,
        n.sent_at,
        n.failure_reason,
        n.event_key,
        n.metadata,
        n.created_at,
        n.updated_at,
        u.name AS customer_name,
        u.email AS customer_email,
        u.phone AS customer_phone,
        p.business_name AS partner_name,
        p.phone AS partner_phone,
        b.booking_number,
        t.template_key
      FROM notifications n
      LEFT JOIN users u ON n.customer_id = u.id
      LEFT JOIN partners p ON n.partner_id = p.id
      LEFT JOIN bookings b ON n.booking_id = b.id
      LEFT JOIN notification_templates t ON n.template_id = t.id
      ${whereSql}
      ORDER BY ${sortColumn} ${sortOrder}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1};
    `;

    const itemsRes = await this.query(itemsSql, [...values, limit, offset]);

    const items = itemsRes.rows.map((row) => this._mapNotificationListItem(row));
    const totalPages = Math.ceil(total / limit) || 1;

    return {
      items,
      pagination: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * Retrieves single notification by ID with rich safe relationships.
   *
   * @param {string} id
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findNotificationById(id, client = null) {
    const sql = `
      SELECT
        n.id,
        n.customer_id,
        n.partner_id,
        n.recipient_type,
        n.type,
        n.title,
        n.body,
        n.data,
        n.channel,
        n.status,
        n.template_id,
        n.booking_id,
        n.sent_by,
        n.read_at,
        n.sent_at,
        n.failure_reason,
        n.event_key,
        n.metadata,
        n.created_at,
        n.updated_at,
        u.id AS customer_user_id,
        u.name AS customer_name,
        u.email AS customer_email,
        u.phone AS customer_phone,
        p.id AS partner_entity_id,
        p.business_name AS partner_name,
        p.owner_name AS partner_owner,
        p.phone AS partner_phone,
        p.email AS partner_email,
        b.id AS booking_entity_id,
        b.booking_number,
        b.booking_status,
        t.id AS template_entity_id,
        t.template_key,
        t.title AS template_title,
        t.notification_type AS template_type,
        s.id AS sender_id,
        s.name AS sender_name,
        s.email AS sender_email,
        s.role AS sender_role
      FROM notifications n
      LEFT JOIN users u ON n.customer_id = u.id
      LEFT JOIN partners p ON n.partner_id = p.id
      LEFT JOIN bookings b ON n.booking_id = b.id
      LEFT JOIN notification_templates t ON n.template_id = t.id
      LEFT JOIN users s ON n.sent_by = s.id
      WHERE n.id = $1
      LIMIT 1;
    `;

    const res = client ? await client.query(sql, [id]) : await this.query(sql, [id]);
    if (!res.rows[0]) return null;

    return this._mapNotificationDetail(res.rows[0]);
  }

  /**
   * Retrieves notification by unique event key for idempotency checking.
   *
   * @param {string} eventKey
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findByEventKey(eventKey, client = null) {
    const sql = `
      SELECT *
      FROM notifications
      WHERE event_key = $1
      LIMIT 1;
    `;
    const res = client ? await client.query(sql, [eventKey]) : await this.query(sql, [eventKey]);
    return res.rows[0] || null;
  }

  /**
   * Inserts notification record into canonical notifications table.
   *
   * @param {object} data
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async createNotification(data, client = null) {
    const sql = `
      INSERT INTO notifications (
        customer_id,
        partner_id,
        recipient_type,
        type,
        title,
        body,
        data,
        channel,
        status,
        template_id,
        booking_id,
        sent_by,
        event_key,
        metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *;
    `;

    const values = [
      data.customerId || null,
      data.partnerId || null,
      data.recipientType || 'CUSTOMER',
      data.type,
      data.title,
      data.body,
      JSON.stringify(data.data || {}),
      data.channel || 'PUSH',
      data.status || 'PENDING',
      data.templateId || null,
      data.bookingId || null,
      data.sentBy || null,
      data.eventKey || null,
      JSON.stringify(data.metadata || {}),
    ];

    const res = client ? await client.query(sql, values) : await this.query(sql, values);
    return res.rows[0];
  }

  /**
   * Inserts partner in-app notification into partner_notifications table.
   *
   * @param {object} data
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async createPartnerNotification(data, client = null) {
    const sql = `
      INSERT INTO partner_notifications (
        partner_id,
        type,
        title,
        body,
        payload,
        event_key
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *;
    `;

    const values = [
      data.partnerId,
      data.type,
      data.title,
      data.body,
      JSON.stringify(data.payload || {}),
      data.eventKey || null,
    ];

    const res = client ? await client.query(sql, values) : await this.query(sql, values);
    return res.rows[0];
  }

  /**
   * Inserts an outbox event for asynchronous notification dispatch.
   *
   * @param {object} data
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async createOutboxEvent(data, client = null) {
    const sql = `
      INSERT INTO outbox_events (
        event_type,
        aggregate_type,
        aggregate_id,
        payload,
        status
      ) VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;

    const values = [
      data.eventType || 'NOTIFICATION_DISPATCH_REQUESTED',
      data.aggregateType || 'NOTIFICATION',
      String(data.aggregateId),
      JSON.stringify(data.payload || {}),
      data.status || 'PENDING',
    ];

    const res = client ? await client.query(sql, values) : await this.query(sql, values);
    return res.rows[0];
  }

  /**
   * Updates notification delivery status post provider send.
   *
   * @param {string} id
   * @param {object} updates
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async updateNotificationDelivery(id, updates, client = null) {
    const sql = `
      UPDATE notifications
      SET
        status = COALESCE($2, status),
        sent_at = COALESCE($3, sent_at),
        failure_reason = COALESCE($4, failure_reason),
        metadata = CASE
          WHEN $5::jsonb IS NOT NULL THEN metadata || $5::jsonb
          ELSE metadata
        END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *;
    `;

    const values = [
      id,
      updates.status || null,
      updates.sentAt || null,
      updates.failureReason || null,
      updates.metadata ? JSON.stringify(updates.metadata) : null,
    ];

    const res = client ? await client.query(sql, values) : await this.query(sql, values);
    return res.rows[0];
  }

  /**
   * Updates outbox event status post delivery.
   *
   * @param {string} aggregateId
   * @param {string} status
   * @param {string} [lastError=null]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<void>}
   */
  async updateOutboxEventStatus(aggregateId, status, lastError = null, client = null) {
    const sql = `
      UPDATE outbox_events
      SET
        status = $2,
        last_error = $3,
        processed_at = CASE WHEN $2 = 'PROCESSED' THEN CURRENT_TIMESTAMP ELSE processed_at END,
        updated_at = CURRENT_TIMESTAMP
      WHERE aggregate_id = $1::text;
    `;

    if (client) {
      await client.query(sql, [String(aggregateId), status, lastError]);
    } else {
      await this.query(sql, [String(aggregateId), status, lastError]);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 2. Recipient & Device Token Resolution
  // ══════════════════════════════════════════════════════════════════════════════

  /**
   * Retrieves registered active push tokens for a recipient.
   * NEVER returns tokens to frontend APIs; internal provider dispatch only.
   *
   * @param {string} recipientId
   * @param {'CUSTOMER'|'PARTNER'} recipientType
   * @returns {Promise<string[]>}
   */
  async findRecipientDeviceTokens(recipientId, recipientType = 'CUSTOMER') {
    if (recipientType === 'PARTNER') {
      const sql = `
        SELECT token AS device_token
        FROM partner_device_tokens
        WHERE partner_id = $1 AND is_active = true;
      `;
      const res = await this.query(sql, [recipientId]);
      return res.rows.map((r) => r.device_token).filter(Boolean);
    }

    try {
      const sql = `
        SELECT device_token
        FROM customer_device_tokens
        WHERE customer_id = $1 AND is_active = true;
      `;
      const res = await this.query(sql, [recipientId]);
      return res.rows.map((r) => r.device_token).filter(Boolean);
    } catch {
      try {
        const fallbackSql = `
          SELECT device_token
          FROM user_devices
          WHERE user_id = $1 AND is_active = true;
        `;
        const res = await this.query(fallbackSql, [recipientId]);
        return res.rows.map((r) => r.device_token).filter(Boolean);
      } catch {
        return [];
      }
    }
  }

  /**
   * Soft-deactivates invalid device tokens reported by FCM.
   *
   * @param {string[]} tokens
   * @param {'CUSTOMER'|'PARTNER'} recipientType
   * @returns {Promise<number>}
   */
  async deactivateDeviceTokens(tokens, recipientType = 'CUSTOMER') {
    if (!Array.isArray(tokens) || tokens.length === 0) return 0;

    if (recipientType === 'PARTNER') {
      const sql = `
        UPDATE partner_device_tokens
        SET is_active = false, updated_at = CURRENT_TIMESTAMP
        WHERE token = ANY($1::text[])
        RETURNING id;
      `;
      const res = await this.query(sql, [tokens]);
      return res.rowCount || 0;
    }

    try {
      const sql = `
        UPDATE customer_device_tokens
        SET is_active = false, updated_at = CURRENT_TIMESTAMP
        WHERE device_token = ANY($1::text[])
        RETURNING id;
      `;
      const res = await this.query(sql, [tokens]);
      return res.rowCount || 0;
    } catch {
      try {
        const fallbackSql = `
          UPDATE user_devices
          SET is_active = false, updated_at = CURRENT_TIMESTAMP
          WHERE device_token = ANY($1::text[])
          RETURNING id;
        `;
        const res = await this.query(fallbackSql, [tokens]);
        return res.rowCount || 0;
      } catch {
        return 0;
      }
    }
  }

  /**
   * Resolves canonical user record.
   *
   * @param {string} userId
   * @returns {Promise<object|null>}
   */
  async getRecipientUser(userId) {
    const sql = `
      SELECT id, role, name, email, phone, is_active
      FROM users
      WHERE id = $1
      LIMIT 1;
    `;
    const res = await this.query(sql, [userId]);
    return res.rows[0] || null;
  }

  /**
   * Resolves canonical partner record.
   *
   * @param {string} partnerId
   * @returns {Promise<object|null>}
   */
  async getRecipientPartner(partnerId) {
    const sql = `
      SELECT
        p.id,
        p.user_id,
        p.business_name,
        COALESCE(u.name, p.business_name) AS owner_name,
        COALESCE(p.contact_email, u.email) AS email,
        COALESCE(p.contact_phone, u.phone) AS phone,
        COALESCE(p.partner_status, p.status) AS status,
        p.is_active
      FROM partners p
      LEFT JOIN users u ON u.id = p.user_id
      WHERE p.id = $1 /* WHERE id = $1 */
      LIMIT 1;
    `;
    const res = await this.query(sql, [partnerId]);
    return res.rows[0] || null;
  }

  /**
   * Verifies booking ownership for BOLA/IDOR protection.
   *
   * @param {string} bookingId
   * @param {string} recipientId
   * @param {'CUSTOMER'|'PARTNER'} recipientType
   * @returns {Promise<object|null>}
   */
  async getBookingForRecipient(bookingId, recipientId, recipientType = 'CUSTOMER') {
    const condition = recipientType === 'PARTNER'
      ? 'partner_id = $2'
      : 'customer_id = $2';

    const sql = `
      SELECT id, booking_number, customer_id, partner_id, booking_status
      FROM bookings
      WHERE id = $1 AND ${condition}
      LIMIT 1;
    `;
    const res = await this.query(sql, [bookingId, recipientId]);
    return res.rows[0] || null;
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 3. Notification Templates Management
  // ══════════════════════════════════════════════════════════════════════════════

  /**
   * Lists notification templates with pagination, search, and audience/channel filters.
   *
   * @param {object} options
   * @returns {Promise<{ items: object[], pagination: object }>}
   */
  async listTemplates(options = {}) {
    const page = Math.max(1, parseInt(options.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(options.limit, 10) || 20));
    const offset = (page - 1) * limit;

    const whereClauses = [];
    const values = [];
    let paramIndex = 1;

    if (options.search && typeof options.search === 'string' && options.search.trim()) {
      const escaped = `%${escapeLikeString(options.search.trim())}%`;
      whereClauses.push(`(t.title ILIKE $${paramIndex} OR t.template_key ILIKE $${paramIndex} OR t.body ILIKE $${paramIndex})`);
      values.push(escaped);
      paramIndex += 1;
    }

    if (options.channel && typeof options.channel === 'string' && options.channel.trim()) {
      whereClauses.push(`t.channel = $${paramIndex}`);
      values.push(options.channel.trim().toUpperCase());
      paramIndex += 1;
    }

    if (options.notificationType && typeof options.notificationType === 'string' && options.notificationType.trim()) {
      whereClauses.push(`t.notification_type = $${paramIndex}`);
      values.push(options.notificationType.trim().toUpperCase());
      paramIndex += 1;
    }

    if (options.targetAudience && typeof options.targetAudience === 'string' && options.targetAudience.trim()) {
      whereClauses.push(`t.target_audience = $${paramIndex}`);
      values.push(options.targetAudience.trim().toUpperCase());
      paramIndex += 1;
    }

    if (options.isActive !== undefined && options.isActive !== null && options.isActive !== '') {
      whereClauses.push(`t.is_active = $${paramIndex}`);
      values.push(options.isActive === 'true' || options.isActive === true);
      paramIndex += 1;
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const requestedSort = (options.sortBy || 'created_at').toLowerCase();
    const sortColumn = ALLOWED_TEMPLATE_SORT_COLUMNS.has(requestedSort) ? `t.${requestedSort}` : 't.created_at';
    const sortOrder = (options.sortOrder || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM notification_templates t
      ${whereSql};
    `;
    const countRes = await this.query(countSql, values);
    const total = parseInt(countRes.rows[0]?.total || 0, 10);

    const itemsSql = `
      SELECT
        t.id,
        t.template_key,
        t.title,
        t.body,
        t.notification_type,
        t.channel,
        t.target_audience,
        t.is_active,
        t.variables,
        t.metadata,
        t.created_by,
        t.updated_by,
        t.created_at,
        t.updated_at,
        c.name AS creator_name,
        u.name AS updater_name
      FROM notification_templates t
      LEFT JOIN users c ON t.created_by = c.id
      LEFT JOIN users u ON t.updated_by = u.id
      ${whereSql}
      ORDER BY ${sortColumn} ${sortOrder}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1};
    `;

    const itemsRes = await this.query(itemsSql, [...values, limit, offset]);

    const items = itemsRes.rows.map((row) => this._mapTemplateItem(row));
    const totalPages = Math.ceil(total / limit) || 1;

    return {
      items,
      pagination: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * Retrieves template by primary key UUID.
   *
   * @param {string} id
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findTemplateById(id, client = null) {
    const sql = `
      SELECT
        t.id,
        t.template_key,
        t.title,
        t.body,
        t.notification_type,
        t.channel,
        t.target_audience,
        t.is_active,
        t.variables,
        t.metadata,
        t.created_by,
        t.updated_by,
        t.created_at,
        t.updated_at,
        c.name AS creator_name,
        u.name AS updater_name
      FROM notification_templates t
      LEFT JOIN users c ON t.created_by = c.id
      LEFT JOIN users u ON t.updated_by = u.id
      WHERE t.id = $1
      LIMIT 1;
    `;
    const res = client ? await client.query(sql, [id]) : await this.query(sql, [id]);
    if (!res.rows[0]) return null;
    return this._mapTemplateItem(res.rows[0]);
  }

  /**
   * Retrieves template by unique template_key.
   *
   * @param {string} key
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findTemplateByKey(key, client = null) {
    const sql = `
      SELECT
        t.id,
        t.template_key,
        t.title,
        t.body,
        t.notification_type,
        t.channel,
        t.target_audience,
        t.is_active,
        t.variables,
        t.metadata,
        t.created_by,
        t.updated_by,
        t.created_at,
        t.updated_at,
        c.name AS creator_name,
        u.name AS updater_name
      FROM notification_templates t
      LEFT JOIN users c ON t.created_by = c.id
      LEFT JOIN users u ON t.updated_by = u.id
      WHERE t.template_key = $1
      LIMIT 1;
    `;
    const res = client ? await client.query(sql, [key]) : await this.query(sql, [key]);
    if (!res.rows[0]) return null;
    return this._mapTemplateItem(res.rows[0]);
  }

  /**
   * Creates a new notification template.
   *
   * @param {object} data
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async createTemplate(data, client = null) {
    const sql = `
      INSERT INTO notification_templates (
        template_key,
        title,
        body,
        notification_type,
        channel,
        target_audience,
        is_active,
        variables,
        metadata,
        created_by,
        updated_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *;
    `;

    const values = [
      data.templateKey.trim().toLowerCase(),
      data.title.trim(),
      data.body.trim(),
      data.notificationType.trim().toUpperCase(),
      data.channel || 'PUSH',
      data.targetAudience || 'ALL',
      data.isActive !== undefined ? data.isActive : true,
      JSON.stringify(Array.isArray(data.variables) ? data.variables : []),
      JSON.stringify(data.metadata || {}),
      data.createdBy || null,
      data.createdBy || null,
    ];

    try {
      const res = client ? await client.query(sql, values) : await this.query(sql, values);
      return this._mapTemplateItem(res.rows[0]);
    } catch (err) {
      this.handleDbError(err, 'NotificationTemplate');
      throw err;
    }
  }

  /**
   * Updates an existing notification template.
   *
   * @param {string} id
   * @param {object} data
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async updateTemplate(id, data, client = null) {
    const sql = `
      UPDATE notification_templates
      SET
        title = COALESCE($2, title),
        body = COALESCE($3, body),
        notification_type = COALESCE($4, notification_type),
        channel = COALESCE($5, channel),
        target_audience = COALESCE($6, target_audience),
        variables = COALESCE($7::jsonb, variables),
        metadata = CASE
          WHEN $8::jsonb IS NOT NULL THEN metadata || $8::jsonb
          ELSE metadata
        END,
        updated_by = $9,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *;
    `;

    const values = [
      id,
      data.title ? data.title.trim() : null,
      data.body ? data.body.trim() : null,
      data.notificationType ? data.notificationType.trim().toUpperCase() : null,
      data.channel || null,
      data.targetAudience || null,
      data.variables ? JSON.stringify(data.variables) : null,
      data.metadata ? JSON.stringify(data.metadata) : null,
      data.updatedBy || null,
    ];

    const res = client ? await client.query(sql, values) : await this.query(sql, values);
    if (!res.rows[0]) return null;
    return this._mapTemplateItem(res.rows[0]);
  }

  /**
   * Toggles active state of a notification template.
   *
   * @param {string} id
   * @param {boolean} isActive
   * @param {string} updatedBy
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async setTemplateActiveState(id, isActive, updatedBy, client = null) {
    const sql = `
      UPDATE notification_templates
      SET
        is_active = $2,
        updated_by = $3,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *;
    `;

    const res = client
      ? await client.query(sql, [id, isActive, updatedBy])
      : await this.query(sql, [id, isActive, updatedBy]);

    if (!res.rows[0]) return null;
    return this._mapTemplateItem(res.rows[0]);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Mappers (Safe Projections - Zero Credential/Token Leakage)
  // ══════════════════════════════════════════════════════════════════════════════

  _mapNotificationListItem(row) {
    const recipient = row.recipient_type === 'PARTNER'
      ? {
        id: row.partner_id,
        type: 'PARTNER',
        name: row.partner_name || 'Partner',
        phone: row.partner_phone,
      }
      : {
        id: row.customer_id,
        type: 'CUSTOMER',
        name: row.customer_name || 'Customer',
        email: row.customer_email,
        phone: row.customer_phone,
      };

    return {
      id: row.id,
      recipientType: row.recipient_type,
      recipient,
      type: row.type,
      title: row.title,
      body: row.body,
      channel: row.channel,
      status: row.status,
      templateKey: row.template_key || null,
      bookingNumber: row.booking_number || null,
      readAt: row.read_at,
      sentAt: row.sent_at,
      createdAt: row.created_at,
    };
  }

  _mapNotificationDetail(row) {
    const recipient = row.recipient_type === 'PARTNER'
      ? {
        id: row.partner_entity_id || row.partner_id,
        type: 'PARTNER',
        name: row.partner_name || 'Partner',
        ownerName: row.partner_owner,
        email: row.partner_email,
        phone: row.partner_phone,
      }
      : {
        id: row.customer_user_id || row.customer_id,
        type: 'CUSTOMER',
        name: row.customer_name || 'Customer',
        email: row.customer_email,
        phone: row.customer_phone,
      };

    return {
      id: row.id,
      recipientType: row.recipient_type,
      recipient,
      type: row.type,
      title: row.title,
      body: row.body,
      data: row.data || {},
      channel: row.channel,
      status: row.status,
      readAt: row.read_at,
      sentAt: row.sent_at,
      failureReason: row.failure_reason,
      eventKey: row.event_key,
      metadata: row.metadata || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      template: row.template_id ? {
        id: row.template_entity_id || row.template_id,
        templateKey: row.template_key,
        title: row.template_title,
        notificationType: row.template_type,
      } : null,
      booking: row.booking_id ? {
        id: row.booking_entity_id || row.booking_id,
        bookingNumber: row.booking_number,
        status: row.booking_status,
      } : null,
      sentBy: row.sent_by ? {
        id: row.sender_id || row.sent_by,
        name: row.sender_name || 'Admin',
        email: row.sender_email,
        role: row.sender_role,
      } : null,
    };
  }

  _mapTemplateItem(row) {
    return {
      id: row.id,
      templateKey: row.template_key,
      title: row.title,
      body: row.body,
      notificationType: row.notification_type,
      channel: row.channel,
      targetAudience: row.target_audience,
      isActive: row.is_active,
      variables: Array.isArray(row.variables) ? row.variables : [],
      metadata: row.metadata || {},
      createdBy: row.created_by,
      creatorName: row.creator_name || null,
      updatedBy: row.updated_by,
      updaterName: row.updater_name || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

const instance = new AdminNotificationRepository();
instance.AdminNotificationRepository = AdminNotificationRepository;
module.exports = instance;
