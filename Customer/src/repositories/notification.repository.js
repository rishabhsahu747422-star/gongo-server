'use strict';

const BaseRepository = require('./base.repository');

/**
 * NotificationRepository — database operations for notifications history mapped to Supabase schema.
 * Supabase table: public.notifications (user_id, notification_type, title, message, data, is_read, read_at)
 */
class NotificationRepository extends BaseRepository {
  /**
   * Projects database row to customer-safe DTO.
   *
   * @param {object|null} row
   * @returns {object|null}
   */
  static mapDto(row) {
    if (!row) return null;

    let parsedData = row.data;
    if (typeof parsedData === 'string') {
      try {
        parsedData = JSON.parse(parsedData);
      } catch {
        parsedData = {};
      }
    }

    const isRead = Boolean(row.is_read || row.read_at);

    return {
      id: row.id,
      customerId: row.user_id || row.customer_id,
      type: row.notification_type || row.type,
      title: row.title,
      body: row.message || row.body,
      data: parsedData || {},
      status: isRead ? 'READ' : (row.status || 'SENT'),
      isRead,
      readAt: row.read_at instanceof Date ? row.read_at.toISOString() : (row.read_at || null),
      sentAt: row.created_at instanceof Date ? row.created_at.toISOString() : (row.sent_at || row.created_at),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
  }

  /**
   * Creates a notification record in Supabase.
   *
   * @param {object} data
   * @param {object} [client]
   * @returns {Promise<object>}
   */
  async create(data, client = null) {
    const runner = client || this;
    try {
      const text = `
        INSERT INTO notifications (
          user_id, notification_type, title, message, data, is_read, read_at
        ) VALUES (
          $1, $2, $3, $4, $5, false, null
        )
        RETURNING *
      `;
      const res = await runner.query(text, [
        data.customerId || data.userId,
        data.type || 'SYSTEM',
        data.title,
        data.body || data.message || '',
        JSON.stringify(data.data || {}),
      ]);
      return NotificationRepository.mapDto(res.rows[0]);
    } catch (err) {
      if (err.message && (err.message.includes('user_id') || err.message.includes('notification_type') || err.message.includes('does not exist'))) {
        const text = `
          INSERT INTO notifications (
            customer_id, type, title, body, data, status, event_key
          ) VALUES (
            $1, $2, $3, $4, $5, 'PENDING', $6
          )
          RETURNING *
        `;
        const res = await runner.query(text, [
          data.customerId || data.userId,
          data.type || 'SYSTEM',
          data.title,
          data.body || data.message || '',
          JSON.stringify(data.data || {}),
          data.eventKey || null,
        ]);
        return NotificationRepository.mapDto(res.rows[0]);
      }
      throw err;
    }
  }

  /**
   * Finds notification by unique event key (or ID).
   *
   * @param {string} eventKey
   * @param {object} [client]
   * @returns {Promise<object|null>}
   */
  async findByEventKey(eventKey, client = null) {
    const text = 'SELECT * FROM notifications WHERE data->>\'eventKey\' = $1 LIMIT 1';
    const runner = client || this;
    try {
      const res = await runner.query(text, [eventKey]);
      return res.rows[0] ? NotificationRepository.mapDto(res.rows[0]) : null;
    } catch {
      return null;
    }
  }

  /**
   * Lists customer notifications with pagination and unread filtering.
   *
   * @param {string} customerId
   * @param {object} options
   * @param {number} [options.page=1]
   * @param {number} [options.limit=20]
   * @param {boolean} [options.unreadOnly=false]
   * @param {object} [client]
   * @returns {Promise<{notifications: object[], pagination: object}>}
   */
  async findByCustomerId(
    customerId,
    { page = 1, limit = 20, unreadOnly = false } = {},
    client = null,
  ) {
    const runner = client || this;
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (safePage - 1) * safeLimit;

    try {
      const conditions = ['user_id = $1'];
      const params = [customerId];
      if (unreadOnly) {
        conditions.push('is_read = false');
      }
      const whereClause = conditions.join(' AND ');

      const countSql = `SELECT COUNT(*) AS total FROM notifications WHERE ${whereClause}`;
      const countRes = await runner.query(countSql, params);
      const total = parseInt(countRes.rows[0]?.total || '0', 10);

      if (total === 0) {
        return {
          notifications: [],
          pagination: {
            page: safePage,
            limit: safeLimit,
            total: 0,
            totalPages: 1,
          },
        };
      }

      const listParams = [...params, safeLimit, offset];
      const listSql = `
        SELECT *
        FROM notifications
        WHERE ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
      `;
      const listRes = await runner.query(listSql, listParams);
      const notifications = listRes.rows.map(NotificationRepository.mapDto);

      return {
        notifications,
        pagination: {
          page: safePage,
          limit: safeLimit,
          total,
          totalPages: Math.ceil(total / safeLimit) || 1,
        },
      };
    } catch (err) {
      if (err.message && (err.message.includes('user_id') || err.message.includes('does not exist'))) {
        const conditions = ['customer_id = $1'];
        const params = [customerId];
        if (unreadOnly) {
          conditions.push('read_at IS NULL');
        }
        const whereClause = conditions.join(' AND ');

        const countSql = `SELECT COUNT(*) AS total FROM notifications WHERE ${whereClause}`;
        const countRes = await runner.query(countSql, params);
        const total = parseInt(countRes.rows[0]?.total || '0', 10);

        if (total === 0) {
          return {
            notifications: [],
            pagination: {
              page: safePage,
              limit: safeLimit,
              total: 0,
              totalPages: 1,
            },
          };
        }

        const listParams = [...params, safeLimit, offset];
        const listSql = `
          SELECT *
          FROM notifications
          WHERE ${whereClause}
          ORDER BY created_at DESC
          LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
        `;
        const listRes = await runner.query(listSql, listParams);
        const notifications = listRes.rows.map(NotificationRepository.mapDto);

        return {
          notifications,
          pagination: {
            page: safePage,
            limit: safeLimit,
            total,
            totalPages: Math.ceil(total / safeLimit) || 1,
          },
        };
      }
      throw err;
    }
  }

  /**
   * Retrieves single notification by ID and Customer ID.
   *
   * @param {string} id
   * @param {string} customerId
   * @param {object} [client]
   * @returns {Promise<object|null>}
   */
  async findByIdAndCustomerId(id, customerId, client = null) {
    const runner = client || this;
    try {
      const text = 'SELECT * FROM notifications WHERE id = $1 AND user_id = $2 LIMIT 1';
      const res = await runner.query(text, [id, customerId]);
      return res.rows[0] ? NotificationRepository.mapDto(res.rows[0]) : null;
    } catch (err) {
      if (err.message && (err.message.includes('user_id') || err.message.includes('does not exist'))) {
        const text = 'SELECT * FROM notifications WHERE id = $1 AND customer_id = $2 LIMIT 1';
        const res = await runner.query(text, [id, customerId]);
        return res.rows[0] ? NotificationRepository.mapDto(res.rows[0]) : null;
      }
      throw err;
    }
  }

  /**
   * Counts unread notifications for customer.
   *
   * @param {string} customerId
   * @param {object} [client]
   * @returns {Promise<number>}
   */
  async getUnreadCount(customerId, client = null) {
    const runner = client || this;
    try {
      const text = 'SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND is_read = false';
      const res = await runner.query(text, [customerId]);
      return parseInt(res.rows[0]?.count || '0', 10);
    } catch (err) {
      if (err.message && (err.message.includes('user_id') || err.message.includes('does not exist'))) {
        const text = 'SELECT COUNT(*) AS count FROM notifications WHERE customer_id = $1 AND read_at IS NULL';
        const res = await runner.query(text, [customerId]);
        return parseInt(res.rows[0]?.count || '0', 10);
      }
      throw err;
    }
  }

  /**
   * Marks a single notification as read (idempotent and respecting check constraint).
   *
   * @param {string} id
   * @param {string} customerId
   * @param {object} [client]
   * @returns {Promise<object|null>}
   */
  async markAsRead(id, customerId, client = null) {
    const runner = client || this;
    try {
      const text = `
        UPDATE notifications
        SET is_read = true,
            read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
        WHERE id = $1 AND user_id = $2
        RETURNING *
      `;
      const res = await runner.query(text, [id, customerId]);
      return res.rows[0] ? NotificationRepository.mapDto(res.rows[0]) : null;
    } catch (err) {
      if (err.message && (err.message.includes('user_id') || err.message.includes('is_read') || err.message.includes('does not exist'))) {
        const text = `
          UPDATE notifications
          SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
          WHERE id = $1 AND customer_id = $2
          RETURNING *
        `;
        const res = await runner.query(text, [id, customerId]);
        return res.rows[0] ? NotificationRepository.mapDto(res.rows[0]) : null;
      }
      throw err;
    }
  }

  /**
   * Marks all unread notifications for a customer as read.
   *
   * @param {string} customerId
   * @param {object} [client]
   * @returns {Promise<number>} Number of marked notifications
   */
  async markAllAsRead(customerId, client = null) {
    const runner = client || this;
    try {
      const text = `
        UPDATE notifications
        SET is_read = true,
            read_at = CURRENT_TIMESTAMP
        WHERE user_id = $1 AND (is_read = false OR is_read IS NULL)
      `;
      const res = await runner.query(text, [customerId]);
      return res.rowCount || 0;
    } catch (err) {
      if (err.message && (err.message.includes('user_id') || err.message.includes('is_read') || err.message.includes('does not exist'))) {
        const text = `
          UPDATE notifications
          SET read_at = CURRENT_TIMESTAMP
          WHERE customer_id = $1 AND read_at IS NULL
        `;
        const res = await runner.query(text, [customerId]);
        return res.rowCount || 0;
      }
      throw err;
    }
  }

  /**
   * Updates delivery status.
   *
   * @param {string} id
   * @param {object} fields
   * @param {string} fields.status
   * @param {string|Date} [fields.sentAt]
   * @param {string} [fields.failureReason]
   * @param {object} [client]
   * @returns {Promise<object|null>}
   */
  async updateDeliveryStatus(id, { status, sentAt = null, failureReason = null }, client = null) {
    const runner = client || this;
    try {
      const text = `
        UPDATE notifications
        SET status = $1,
            sent_at = COALESCE($2, sent_at),
            failure_reason = COALESCE($3, failure_reason),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $4
        RETURNING *
      `;
      const res = await runner.query(text, [status, sentAt, failureReason, id]);
      if (res.rows && res.rows[0]) {
        return NotificationRepository.mapDto(res.rows[0]);
      }
    } catch {
      // Fallback for Supabase where deliveryStatus is tracked in jsonb data
      try {
        const text = `
          UPDATE notifications
          SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{deliveryStatus}', to_jsonb($1::text))
          WHERE id = $2
          RETURNING *
        `;
        const res = await runner.query(text, [status, id]);
        return res.rows[0] ? NotificationRepository.mapDto(res.rows[0]) : null;
      } catch {
        return null;
      }
    }
  }
}

module.exports = NotificationRepository;
