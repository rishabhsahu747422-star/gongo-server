'use strict';

const BaseRepository = require('../db/base.repository');

class NotificationRepository extends BaseRepository {
  constructor() {
    super('partner_notifications', 'id');
  }

  /**
   * Find paginated notifications for an authenticated partner.
   *
   * @param {string} partnerId
   * @param {object} [options={}]
   * @param {number} [options.limit=20]
   * @param {number} [options.offset=0]
   * @param {boolean} [options.isRead]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ rows: Array<object>, total: number }>}
   */
  async findPaginatedByPartnerId(partnerId, options = {}, client = null) {
    const {
      limit = 20,
      offset = 0,
      isRead,
    } = options;

    const whereClauses = ['n.partner_id = $1'];
    const queryParams = [partnerId];
    const paramIndex = 2;

    if (isRead === true) {
      whereClauses.push('n.read_at IS NOT NULL');
    } else if (isRead === false) {
      whereClauses.push('n.read_at IS NULL');
    }

    const whereSql = whereClauses.join(' AND ');

    // 1. Total count query
    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM ${this.tableName} n
      WHERE ${whereSql};
    `;
    const countRes = client
      ? await client.query(countSql, queryParams)
      : await this.query(countSql, queryParams);
    const total = Number(countRes.rows[0]?.total || 0);

    // 2. Data rows query
    const dataSql = `
      SELECT
        n.id,
        n.partner_id,
        n.type,
        n.title,
        n.body,
        n.payload,
        n.read_at,
        n.event_key,
        n.created_at
      FROM ${this.tableName} n
      WHERE ${whereSql}
      ORDER BY n.created_at DESC, n.id DESC
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
   * Get unread notifications count for partner.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<number>}
   */
  async getUnreadCountByPartnerId(partnerId, client = null) {
    const sql = `
      SELECT COUNT(*)::int AS count
      FROM ${this.tableName}
      WHERE partner_id = $1 AND read_at IS NULL;
    `;

    const res = client
      ? await client.query(sql, [partnerId])
      : await this.query(sql, [partnerId]);

    return Number(res.rows[0]?.count || 0);
  }

  /**
   * Mark a single notification as read (with BOLA check).
   *
   * @param {string} id
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async markAsReadByIdAndPartnerId(id, partnerId, client = null) {
    const sql = `
      UPDATE ${this.tableName}
      SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
      WHERE id = $1 AND partner_id = $2
      RETURNING *;
    `;

    const res = client
      ? await client.query(sql, [id, partnerId])
      : await this.query(sql, [id, partnerId]);

    return res.rows[0] || null;
  }

  /**
   * Mark all notifications as read for a partner.
   *
   * @param {string} partnerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<number>}
   */
  async markAllAsReadByPartnerId(partnerId, client = null) {
    const sql = `
      UPDATE ${this.tableName}
      SET read_at = CURRENT_TIMESTAMP
      WHERE partner_id = $1 AND read_at IS NULL;
    `;

    const res = client
      ? await client.query(sql, [partnerId])
      : await this.query(sql, [partnerId]);

    return res.rowCount || 0;
  }

  /**
   * Create an in-app notification with idempotency support via event_key.
   *
   * @param {object} notificationData
   * @param {string} notificationData.partnerId
   * @param {string} notificationData.type
   * @param {string} notificationData.title
   * @param {string} notificationData.body
   * @param {object} [notificationData.payload]
   * @param {string} [notificationData.eventKey]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async createNotification(notificationData, client = null) {
    const {
      partnerId,
      type,
      title,
      body,
      payload = {},
      eventKey = null,
    } = notificationData;

    const sql = `
      INSERT INTO ${this.tableName} (
        partner_id, type, title, body, payload, event_key
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (partner_id, event_key) DO NOTHING
      RETURNING *;
    `;

    const params = [
      partnerId,
      type,
      title,
      body,
      JSON.stringify(payload),
      eventKey,
    ];

    const res = client
      ? await client.query(sql, params)
      : await this.query(sql, params);

    return res.rows[0] || null;
  }

  /**
   * Register or update partner FCM device token.
   *
   * @param {string} partnerId
   * @param {string} token
   * @param {string} [platform='android']
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async upsertDeviceToken(partnerId, token, platform = 'android', client = null) {
    const sql = `
      INSERT INTO partner_device_tokens (
        partner_id, token, platform, is_active, updated_at
      )
      VALUES ($1, $2, $3, true, CURRENT_TIMESTAMP)
      ON CONFLICT (partner_id, token) DO UPDATE SET
        platform = EXCLUDED.platform,
        is_active = true,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *;
    `;

    const res = client
      ? await client.query(sql, [partnerId, token, platform])
      : await this.query(sql, [partnerId, token, platform]);

    return res.rows[0];
  }

  /**
   * Remove or deactivate a partner FCM device token on logout.
   *
   * @param {string} partnerId
   * @param {string} token
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<boolean>}
   */
  async removeDeviceToken(partnerId, token, client = null) {
    const sql = `
      DELETE FROM partner_device_tokens
      WHERE partner_id = $1 AND token = $2
      RETURNING id;
    `;

    const res = client
      ? await client.query(sql, [partnerId, token])
      : await this.query(sql, [partnerId, token]);

    return res.rows.length > 0;
  }
}

module.exports = NotificationRepository;
