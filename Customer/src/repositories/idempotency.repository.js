'use strict';

const BaseRepository = require('./base.repository');

/**
 * IdempotencyRepository manages persistent idempotency records
 * for mutating requests (such as POST /api/v1/bookings).
 */
class IdempotencyRepository extends BaseRepository {
  /**
   * Look up an existing idempotency record by userId and key.
   *
   * @param {string} userId
   * @param {string} key
   * @param {object} [client] - Optional transactional client
   * @returns {Promise<object|null>}
   */
  async findKey(userId, key, client = null) {
    const text = `
      SELECT id, key, user_id, request_path, request_hash,
             response_status, response_body, created_at, expires_at
      FROM idempotency_keys
      WHERE user_id = $1 AND key = $2 AND expires_at > $3
      LIMIT 1
    `;
    const runner = client || this;
    const res = await runner.query(text, [userId, key, new Date()]);
    const row = res.rows[0] || null;
    if (row && typeof row.response_body === 'string') {
      try {
        row.response_body = JSON.parse(row.response_body);
      } catch (_) {
        // Keep as string if parsing fails
      }
    }
    return row;
  }

  /**
   * Save a completed response for an idempotency key.
   *
   * @param {object} params
   * @param {string} params.userId
   * @param {string} params.key
   * @param {string} params.requestPath
   * @param {string} params.requestHash
   * @param {number} params.responseStatus
   * @param {object} params.responseBody
   * @param {number} [params.ttlHours=24]
   * @param {object} [params.client]
   * @returns {Promise<object>}
   */
  async saveKey({
    userId,
    key,
    requestPath,
    requestHash,
    responseStatus,
    responseBody,
    ttlHours = 24,
    client = null,
  }) {
    const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);
    const text = `
      INSERT INTO idempotency_keys (
        key, user_id, request_path, request_hash,
        response_status, response_body, expires_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7
      )
      RETURNING *
    `;
    const runner = client || this;
    const res = await runner.query(text, [
      key,
      userId,
      requestPath,
      requestHash,
      responseStatus,
      JSON.stringify(responseBody),
      expiresAt,
    ]);
    return res.rows[0];
  }
}

module.exports = IdempotencyRepository;
