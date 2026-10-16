'use strict';

const BaseRepository = require('./base.repository');

/**
 * DeviceTokenRepository — manages customer device token persistence in Supabase user_devices table.
 */
class DeviceTokenRepository extends BaseRepository {
  /**
   * Projects a raw database row into a safe, client-facing Device DTO.
   *
   * @param {object|null} row
   * @returns {object|null}
   */
  static mapDto(row) {
    if (!row) return null;

    const formatDate = (val) => (val instanceof Date ? val.toISOString() : val);

    return {
      id: row.id,
      platform: row.platform,
      appVersion: row.app_version || null,
      deviceId: row.device_id || null,
      isActive: Boolean(row.is_active),
      lastSeenAt: formatDate(row.last_seen_at),
      createdAt: formatDate(row.created_at),
      updatedAt: formatDate(row.updated_at),
    };
  }

  /**
   * Upserts a device token in Supabase user_devices.
   *
   * @param {object} params
   * @param {string} params.customerId
   * @param {string} params.deviceToken
   * @param {string} params.platform
   * @param {string} [params.appVersion]
   * @param {string} [params.deviceId]
   * @param {object} [client]
   * @returns {Promise<object>}
   */
  async upsertToken(
    { customerId, deviceToken, platform, appVersion = null, deviceId = null },
    client = null,
  ) {
    const rawPlatform = (platform || 'android').toLowerCase();
    const safePlatform = ['android', 'ios', 'web'].includes(rawPlatform) ? rawPlatform : 'android';
    const runner = client || this;

    try {
      const text = `
        INSERT INTO user_devices (
          user_id, device_token, platform, device_id, is_active, last_seen_at
        ) VALUES (
          $1, $2, $3, $4, true, CURRENT_TIMESTAMP
        )
        ON CONFLICT (device_token) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          platform = EXCLUDED.platform,
          device_id = COALESCE(EXCLUDED.device_id, user_devices.device_id),
          is_active = true,
          last_seen_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        RETURNING *
      `;
      const res = await runner.query(text, [
        customerId,
        deviceToken,
        safePlatform,
        deviceId,
      ]);
      return DeviceTokenRepository.mapDto(res.rows[0]);
    } catch (err) {
      if (err.message && (err.message.includes('user_devices') || err.message.includes('does not exist'))) {
        const text = `
          INSERT INTO customer_device_tokens (
            customer_id, device_token, platform, app_version, device_id, is_active, last_seen_at
          ) VALUES (
            $1, $2, $3, $4, $5, true, CURRENT_TIMESTAMP
          )
          ON CONFLICT (device_token) DO UPDATE SET
            customer_id = EXCLUDED.customer_id,
            platform = EXCLUDED.platform,
            app_version = COALESCE(EXCLUDED.app_version, customer_device_tokens.app_version),
            device_id = COALESCE(EXCLUDED.device_id, customer_device_tokens.device_id),
            is_active = true,
            last_seen_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
          RETURNING *
        `;
        const res = await runner.query(text, [
          customerId,
          deviceToken,
          (platform || 'ANDROID').toUpperCase(),
          appVersion,
          deviceId,
        ]);
        return DeviceTokenRepository.mapDto(res.rows[0]);
      }
      throw err;
    }
  }

  /**
   * Retrieves active device tokens for a customer.
   *
   * @param {string} customerId
   * @param {object} [client]
   * @returns {Promise<Array<{token: string, id: string, platform: string}>>}
   */
  async findActiveByCustomerId(customerId, client = null) {
    const runner = client || this;
    try {
      const text = `
        SELECT id, device_token, platform, device_id, is_active, last_seen_at, created_at, updated_at
        FROM user_devices
        WHERE user_id = $1 AND is_active = true
        ORDER BY last_seen_at DESC
      `;
      const res = await runner.query(text, [customerId]);
      return res.rows.map((row) => ({
        id: row.id,
        deviceToken: row.device_token,
        platform: row.platform,
        appVersion: null,
        deviceId: row.device_id,
      }));
    } catch (err) {
      if (err.message && (err.message.includes('user_devices') || err.message.includes('does not exist'))) {
        const text = `
          SELECT id, device_token, platform, device_id, is_active, last_seen_at, created_at, updated_at
          FROM customer_device_tokens
          WHERE customer_id = $1 AND is_active = true
          ORDER BY last_seen_at DESC
        `;
        const res = await runner.query(text, [customerId]);
        return res.rows.map((row) => ({
          id: row.id,
          deviceToken: row.device_token,
          platform: row.platform,
          appVersion: row.app_version || null,
          deviceId: row.device_id,
        }));
      }
      throw err;
    }
  }

  /**
   * Retrieves all registered devices for a customer.
   *
   * @param {string} customerId
   * @param {object} [client]
   * @returns {Promise<object[]>}
   */
  async findAllByCustomerId(customerId, client = null) {
    const runner = client || this;
    try {
      const text = `
        SELECT *
        FROM user_devices
        WHERE user_id = $1
        ORDER BY is_active DESC, last_seen_at DESC
      `;
      const res = await runner.query(text, [customerId]);
      return res.rows.map(DeviceTokenRepository.mapDto);
    } catch (err) {
      if (err.message && (err.message.includes('user_devices') || err.message.includes('does not exist'))) {
        const text = `
          SELECT *
          FROM customer_device_tokens
          WHERE customer_id = $1
          ORDER BY is_active DESC, last_seen_at DESC
        `;
        const res = await runner.query(text, [customerId]);
        return res.rows.map(DeviceTokenRepository.mapDto);
      }
      throw err;
    }
  }

  /**
   * Finds a device record by customer ID and device ID.
   *
   * @param {string} customerId
   * @param {string} id
   * @param {object} [client]
   * @returns {Promise<object|null>}
   */
  async findByIdAndCustomerId(customerId, id, client = null) {
    const runner = client || this;
    try {
      const text = `
        SELECT *
        FROM user_devices
        WHERE user_id = $1 AND id = $2
        LIMIT 1
      `;
      const res = await runner.query(text, [customerId, id]);
      return res.rows[0] ? DeviceTokenRepository.mapDto(res.rows[0]) : null;
    } catch (err) {
      if (err.message && (err.message.includes('user_devices') || err.message.includes('does not exist'))) {
        const text = `
          SELECT *
          FROM customer_device_tokens
          WHERE customer_id = $1 AND id = $2
          LIMIT 1
        `;
        const res = await runner.query(text, [customerId, id]);
        return res.rows[0] ? DeviceTokenRepository.mapDto(res.rows[0]) : null;
      }
      throw err;
    }
  }

  /**
   * Deactivates a device by customer ID and device record ID.
   *
   * @param {string} customerId
   * @param {string} id
   * @param {object} [client]
   * @returns {Promise<object|null>}
   */
  async deactivate(customerId, id, client = null) {
    const runner = client || this;
    try {
      const text = `
        UPDATE user_devices
        SET is_active = false, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $1 AND id = $2
        RETURNING *
      `;
      const res = await runner.query(text, [customerId, id]);
      return res.rows[0] ? DeviceTokenRepository.mapDto(res.rows[0]) : null;
    } catch (err) {
      if (err.message && (err.message.includes('user_devices') || err.message.includes('does not exist'))) {
        const text = `
          UPDATE customer_device_tokens
          SET is_active = false, updated_at = CURRENT_TIMESTAMP
          WHERE customer_id = $1 AND id = $2
          RETURNING *
        `;
        const res = await runner.query(text, [customerId, id]);
        return res.rows[0] ? DeviceTokenRepository.mapDto(res.rows[0]) : null;
      }
      throw err;
    }
  }

  /**
   * Bulk deactivates device tokens that were reported as unregistered or invalid by FCM.
   *
   * @param {string[]} tokens
   * @param {object} [client]
   * @returns {Promise<number>} Number of deactivated rows
   */
  async deactivateByTokens(tokens, client = null) {
    if (!Array.isArray(tokens) || tokens.length === 0) {
      return 0;
    }

    const runner = client || this;
    try {
      const text = `
        UPDATE user_devices
        SET is_active = false, updated_at = CURRENT_TIMESTAMP
        WHERE device_token = ANY($1::varchar[])
      `;
      const res = await runner.query(text, [tokens]);
      return res.rowCount;
    } catch (err) {
      if (err.message && (err.message.includes('user_devices') || err.message.includes('does not exist'))) {
        const text = `
          UPDATE customer_device_tokens
          SET is_active = false, updated_at = CURRENT_TIMESTAMP
          WHERE device_token = ANY($1::varchar[])
        `;
        const res = await runner.query(text, [tokens]);
        return res.rowCount;
      }
      throw err;
    }
  }
}

module.exports = DeviceTokenRepository;
