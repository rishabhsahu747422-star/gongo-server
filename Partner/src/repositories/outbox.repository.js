'use strict';

const BaseRepository = require('../db/base.repository');

/**
 * outbox_events is shared with the Admin outbox worker, which claims these event
 * types (see Admin/src/repositories/admin-outbox.repository.js; keep both in sync).
 * Partner must skip them, or its default handler would mark them completed unprocessed.
 */
const ADMIN_OWNED_EVENT_PREDICATE = `(
  UPPER(COALESCE(aggregate_type, '')) = 'NOTIFICATION'
  OR UPPER(COALESCE(event_type, '')) LIKE 'NOTIFICATION\\_%'
  OR UPPER(COALESCE(event_type, '')) IN ('SEND_PUSH', 'PAYOUT_CHECK', 'EXPIRED_SESSIONS')
  OR UPPER(COALESCE(event_type, '')) LIKE '%RECONCIL%'
  OR UPPER(COALESCE(event_type, '')) LIKE '%WALLET\\_AUDIT%'
  OR UPPER(COALESCE(event_type, '')) LIKE '%CLEANUP%'
  OR UPPER(COALESCE(event_type, '')) LIKE '%PURGE%'
)`;

/**
 * Repository for transactional outbox events.
 * Guarantees zero lost events between PostgreSQL transaction commits and async side-effects.
 */
class OutboxRepository extends BaseRepository {
  constructor() {
    super('outbox_events');
  }

  /**
   * Inserts an outbox event atomically within a business transaction.
   *
   * @param {object} params
   * @param {string} params.eventType
   * @param {string} params.aggregateType
   * @param {string} params.aggregateId
   * @param {object} [params.payload={}]
   * @param {number} [params.maxRetries=5]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async createEvent(params, client = null) {
    const {
      eventType,
      aggregateType,
      aggregateId,
      payload = {},
      maxRetries = 5,
    } = params;

    const sql = `
      INSERT INTO ${this.tableName} (
        event_type, aggregate_type, aggregate_id, payload, max_retries
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;

    const values = [
      eventType,
      aggregateType,
      String(aggregateId),
      JSON.stringify(payload),
      maxRetries,
    ];

    const res = client
      ? await client.query(sql, values)
      : await this.query(sql, values);

    return res.rows[0];
  }

  /**
   * Fetches pending or failed events ready for retry using row-level locks (SKIP LOCKED).
   *
   * @param {number} [batchSize=10]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<Array<object>>}
   */
  async fetchPendingEvents(batchSize = 10, client = null) {
    const sql = `
      SELECT *
      FROM ${this.tableName}
      WHERE status IN ('PENDING', 'FAILED')
        AND next_retry_at <= CURRENT_TIMESTAMP
        AND NOT ${ADMIN_OWNED_EVENT_PREDICATE}
      ORDER BY created_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED;
    `;

    const res = client
      ? await client.query(sql, [batchSize])
      : await this.query(sql, [batchSize]);

    return res.rows;
  }

  /**
   * Marks an outbox event as successfully processed.
   *
   * @param {string} id
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async markCompleted(id, client = null) {
    const sql = `
      UPDATE ${this.tableName}
      SET status = 'COMPLETED',
          processed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *;
    `;

    const res = client
      ? await client.query(sql, [id])
      : await this.query(sql, [id]);

    return res.rows[0] || null;
  }

  /**
   * Marks an outbox event as failed with bounded exponential backoff.
   *
   * @param {string} id
   * @param {string|Error} error
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async markFailed(id, error, client = null) {
    let errorMessage = 'Unknown outbox processing error';
    if (typeof error === 'string') {
      errorMessage = error;
    } else if (error && error.message) {
      errorMessage = error.message;
    }

    // Fetch current retry count and max_retries
    const fetchSql = `
      SELECT retry_count, max_retries
      FROM ${this.tableName}
      WHERE id = $1;
    `;
    const fetchRes = client
      ? await client.query(fetchSql, [id])
      : await this.query(fetchSql, [id]);

    if (!fetchRes.rows.length) {
      return null;
    }

    const currentRetries = fetchRes.rows[0].retry_count;
    const maxRetries = fetchRes.rows[0].max_retries;
    const newRetryCount = currentRetries + 1;

    // Bounded exponential backoff: 2^retries * 5 seconds, capped at 300 seconds (5 min)
    const backoffSeconds = Math.min(300, (2 ** currentRetries) * 5);
    const isDeadLetter = newRetryCount >= maxRetries;
    const newStatus = isDeadLetter ? 'DEAD_LETTER' : 'FAILED';

    const updateSql = `
      UPDATE ${this.tableName}
      SET status = $1,
          retry_count = $2,
          last_error = $3,
          next_retry_at = CURRENT_TIMESTAMP + ($4 || ' seconds')::interval,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $5
      RETURNING *;
    `;

    const res = client
      ? await client.query(updateSql, [newStatus, newRetryCount, errorMessage, backoffSeconds, id])
      : await this.query(updateSql, [newStatus, newRetryCount, errorMessage, backoffSeconds, id]);

    return res.rows[0] || null;
  }

  /**
   * Returns outbox operational statistics.
   *
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async getOutboxStats(client = null) {
    const sql = `
      SELECT
        COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'PROCESSING')::int AS processing,
        COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
        COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
        COUNT(*) FILTER (WHERE status = 'DEAD_LETTER')::int AS dead_letter,
        COUNT(*)::int AS total
      FROM ${this.tableName};
    `;

    const res = client
      ? await client.query(sql)
      : await this.query(sql);

    const row = res.rows[0] || {};
    return {
      pending: row.pending || 0,
      processing: row.processing || 0,
      completed: row.completed || 0,
      failed: row.failed || 0,
      deadLetter: row.dead_letter || 0,
      total: row.total || 0,
    };
  }
}

module.exports = OutboxRepository;
