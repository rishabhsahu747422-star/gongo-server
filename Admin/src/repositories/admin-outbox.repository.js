'use strict';

const BaseRepository = require('../db/base.repository');
const { sanitizeMeta } = require('../config/logger');

let mockOutboxResolver = null;

/**
 * outbox_events is shared with the Partner outbox worker. This predicate mirrors
 * jobs/handlers/index.js dispatchEvent(): the Admin worker claims only events it can
 * handle, and Partner's repository claims the complement (keep both in sync).
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
 * Dedicated Outbox Repository for Transactional Reliability & Background Operations.
 *
 * Implements:
 * - Atomic event claims with PostgreSQL row-level locking (FOR UPDATE SKIP LOCKED)
 * - Safe lease tracking and stale worker recovery
 * - Bounded retry policy with exponential backoff and jitter
 * - Dead-letter (terminal FAILED) categorization
 * - Safe operational visibility with credential & token redaction
 */
class AdminOutboxRepository extends BaseRepository {
  constructor() {
    super('outbox_events', 'id');
  }

  /**
   * For unit testing: inject mock resolver
   * @param {Function|null} resolver
   */
  static setMockResolver(resolver) {
    mockOutboxResolver = resolver;
  }

  static resetMockResolver() {
    mockOutboxResolver = null;
  }

  /**
   * Creates an outbox event in the same transaction as a source domain mutation.
   *
   * @param {object} eventData
   * @param {string} eventData.eventType Canonical event name
   * @param {string} eventData.aggregateType Target domain (e.g. NOTIFICATION, PAYMENT, SYSTEM)
   * @param {string} eventData.aggregateId Primary key of source entity
   * @param {object} [eventData.payload={}] Sanitized event payload
   * @param {number} [eventData.maxRetries=5] Configured retry ceiling
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async createEvent(eventData, client = null) {
    if (mockOutboxResolver && mockOutboxResolver.createEvent) {
      return mockOutboxResolver.createEvent(eventData, client);
    }

    const sql = `
      INSERT INTO outbox_events (
        event_type,
        aggregate_type,
        aggregate_id,
        payload,
        status,
        max_retries,
        next_retry_at
      ) VALUES ($1, $2, $3, $4, 'PENDING', $5, CURRENT_TIMESTAMP)
      RETURNING *;
    `;

    const values = [
      eventData.eventType,
      eventData.aggregateType || 'SYSTEM',
      String(eventData.aggregateId),
      JSON.stringify(sanitizeMeta(eventData.payload || {})),
      eventData.maxRetries !== undefined ? parseInt(eventData.maxRetries, 10) : 5,
    ];

    const res = client ? await client.query(sql, values) : await this.query(sql, values);
    return res.rows[0];
  }

  /**
   * Atomically claims a batch of pending or retry-eligible outbox events.
   * Uses PostgreSQL FOR UPDATE SKIP LOCKED to prevent concurrent worker duplication.
   *
   * @param {object} options
   * @param {number} [options.batchSize=10] Maximum items to claim (bounded 1..100)
   * @param {string} options.workerId Unique worker instance identifier
   * @param {number} [options.leaseSeconds=300] Lock duration before job is considered stale
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object[]>} Claimed outbox records
   */
  async claimEvents(options = {}, client = null) {
    if (mockOutboxResolver && mockOutboxResolver.claimEvents) {
      return mockOutboxResolver.claimEvents(options, client);
    }

    const batchSize = Math.min(100, Math.max(1, parseInt(options.batchSize, 10) || 10));
    const workerId = String(options.workerId || 'default-worker');

    const sql = `
      WITH eligible AS (
        SELECT id
        FROM outbox_events
        WHERE ((status = 'PENDING' AND next_retry_at <= CURRENT_TIMESTAMP)
           OR (status = 'FAILED' AND retry_count < max_retries AND next_retry_at <= CURRENT_TIMESTAMP))
          AND ${ADMIN_OWNED_EVENT_PREDICATE}
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_events o
      SET
        status = 'PROCESSING',
        locked_at = CURRENT_TIMESTAMP,
        locked_by = $2,
        updated_at = CURRENT_TIMESTAMP
      FROM eligible
      WHERE o.id = eligible.id
      RETURNING o.id, o.event_type, o.aggregate_type, o.aggregate_id, o.payload,
                o.status, o.retry_count, o.max_retries, o.next_retry_at,
                o.last_error, o.processed_at, o.created_at, o.locked_at, o.locked_by;
    `;

    const res = client
      ? await client.query(sql, [batchSize, workerId])
      : await this.query(sql, [batchSize, workerId]);

    return res.rows;
  }

  /**
   * Marks an outbox event as successfully PROCESSED.
   * Clears worker lease lock and records processed timestamp.
   *
   * @param {string} id
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async markProcessed(id, client = null) {
    if (mockOutboxResolver && mockOutboxResolver.markProcessed) {
      return mockOutboxResolver.markProcessed(id, client);
    }

    const sql = `
      UPDATE outbox_events
      SET
        status = 'PROCESSED',
        processed_at = CURRENT_TIMESTAMP,
        locked_at = NULL,
        locked_by = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *;
    `;

    const res = client ? await client.query(sql, [id]) : await this.query(sql, [id]);
    return res.rows[0] || null;
  }

  /**
   * Handles job failure with exponential backoff and error sanitization.
   * If retryable and attempt < max_retries, schedules next retry.
   * If non-retryable or max retries exceeded, marks as terminal FAILED (dead-letter).
   *
   * @param {string} id Event ID
   * @param {string|Error} error Failure description or error object
   * @param {object} [options={}]
   * @param {boolean} [options.isRetryable=false] Whether this failure is transient
   * @param {number} [options.baseBackoffMs=1000] Initial retry delay in ms
   * @param {number} [options.maxBackoffMs=300000] Maximum retry delay in ms (5 min)
   * @param {boolean} [options.jitter=true] Whether to apply randomization to avoid thundering herd
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async markFailed(id, error, options = {}, client = null) {
    if (mockOutboxResolver && mockOutboxResolver.markFailed) {
      return mockOutboxResolver.markFailed(id, error, options, client);
    }

    const rawMsg = error instanceof Error ? error.message : String(error || 'Unknown error');
    // Sanitize error string to prevent persisting leaked tokens/passwords
    const sanitizedError = rawMsg
      .replace(/bearer\s+[a-zA-Z0-9_\-.]+/gi, 'Bearer [REDACTED]')
      .replace(/password[:=]\s*\S+/gi, 'password=[REDACTED]')
      .replace(/key[:=]\s*\S+/gi, 'key=[REDACTED]')
      .slice(0, 1000);

    const isRetryable = Boolean(options.isRetryable);
    const baseBackoffMs = options.baseBackoffMs || 1000;
    const maxBackoffMs = options.maxBackoffMs || 300000;
    const jitter = options.jitter !== false;

    // Fetch existing record to check retry thresholds
    const current = await this.findById(id, client);
    if (!current) {
      return null;
    }

    const nextRetryCount = (current.retry_count || 0) + 1;
    const maxRetries = current.max_retries || 5;

    if (isRetryable && nextRetryCount < maxRetries) {
      // Calculate exponential backoff: base * 2^attempt + jitter
      const expDelay = Math.min(maxBackoffMs, baseBackoffMs * (2 ** (nextRetryCount - 1)));
      const jitterMs = jitter ? Math.floor(Math.random() * Math.min(1000, expDelay * 0.2)) : 0;
      const totalDelaySec = Math.max(1, Math.round((expDelay + jitterMs) / 1000));

      const sql = `
        UPDATE outbox_events
        SET
          status = 'PENDING',
          retry_count = $2,
          next_retry_at = CURRENT_TIMESTAMP + ($3 || ' seconds')::interval,
          last_error = $4,
          locked_at = NULL,
          locked_by = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *;
      `;

      const res = client
        ? await client.query(sql, [id, nextRetryCount, String(totalDelaySec), sanitizedError])
        : await this.query(sql, [id, nextRetryCount, String(totalDelaySec), sanitizedError]);

      return res.rows[0] || null;
    }

    // Terminal failure (Non-retryable or exceeded max retries)
    const sql = `
      UPDATE outbox_events
      SET
        status = 'FAILED',
        retry_count = $2,
        last_error = $3,
        locked_at = NULL,
        locked_by = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *;
    `;

    const res = client
      ? await client.query(sql, [id, nextRetryCount, sanitizedError])
      : await this.query(sql, [id, nextRetryCount, sanitizedError]);

    return res.rows[0] || null;
  }

  /**
   * Concurrency-safe recovery of jobs stuck in PROCESSING due to worker crashes or timeouts.
   * Only recovers jobs whose lease has expired (> leaseSeconds ago).
   *
   * @param {number} [leaseSeconds=300] Stale threshold
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<string[]>} Recovered job IDs
   */
  async recoverStaleJobs(leaseSeconds = 300, client = null) {
    if (mockOutboxResolver && mockOutboxResolver.recoverStaleJobs) {
      return mockOutboxResolver.recoverStaleJobs(leaseSeconds, client);
    }

    const leaseSec = Math.max(30, parseInt(leaseSeconds, 10) || 300);

    const sql = `
      WITH stale AS (
        SELECT id
        FROM outbox_events
        WHERE status = 'PROCESSING'
          AND locked_at < CURRENT_TIMESTAMP - ($1 || ' seconds')::interval
        LIMIT 50
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_events o
      SET
        status = 'PENDING',
        locked_at = NULL,
        locked_by = NULL,
        updated_at = CURRENT_TIMESTAMP
      FROM stale
      WHERE o.id = stale.id
      RETURNING o.id;
    `;

    const res = client
      ? await client.query(sql, [String(leaseSec)])
      : await this.query(sql, [String(leaseSec)]);

    return res.rows.map((row) => row.id);
  }

  /**
   * Releases worker leases during clean graceful shutdown.
   * Immediately frees claimed jobs so other workers can process them
   * without waiting for stale timeout.
   *
   * @param {string} workerId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<number>} Number of released jobs
   */
  async releaseWorkerLeases(workerId, client = null) {
    if (mockOutboxResolver && mockOutboxResolver.releaseWorkerLeases) {
      return mockOutboxResolver.releaseWorkerLeases(workerId, client);
    }

    if (!workerId) return 0;

    const sql = `
      UPDATE outbox_events
      SET
        status = 'PENDING',
        locked_at = NULL,
        locked_by = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE status = 'PROCESSING' AND locked_by = $1;
    `;

    const res = client ? await client.query(sql, [workerId]) : await this.query(sql, [workerId]);
    return res.rowCount || 0;
  }

  /**
   * Retrieves operational health statistics for outbox processing.
   *
   * @param {number} [leaseSeconds=300]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async getQueueStats(leaseSeconds = 300, client = null) {
    if (mockOutboxResolver && mockOutboxResolver.getQueueStats) {
      return mockOutboxResolver.getQueueStats(leaseSeconds, client);
    }

    const leaseSec = Math.max(30, parseInt(leaseSeconds, 10) || 300);

    const sql = `
      SELECT
        COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending_count,
        COUNT(*) FILTER (WHERE status = 'PROCESSING')::int AS processing_count,
        COUNT(*) FILTER (
          WHERE status = 'PROCESSING'
            AND locked_at < CURRENT_TIMESTAMP - ($1 || ' seconds')::interval
        )::int AS stale_count,
        COUNT(*) FILTER (WHERE status = 'PROCESSED')::int AS processed_count,
        COUNT(*) FILTER (WHERE status = 'FAILED' AND retry_count >= max_retries)::int AS dead_letter_count,
        COUNT(*) FILTER (WHERE status = 'FAILED' AND retry_count < max_retries)::int AS retryable_failed_count,
        COUNT(*)::int AS total_events,
        MIN(created_at) FILTER (WHERE status = 'PENDING') AS oldest_pending_at
      FROM outbox_events;
    `;

    const res = client
      ? await client.query(sql, [String(leaseSec)])
      : await this.query(sql, [String(leaseSec)]);

    const row = res.rows[0] || {};
    return {
      pendingCount: parseInt(row.pending_count || 0, 10),
      processingCount: parseInt(row.processing_count || 0, 10),
      staleCount: parseInt(row.stale_count || 0, 10),
      processedCount: parseInt(row.processed_count || 0, 10),
      deadLetterCount: parseInt(row.dead_letter_count || 0, 10),
      retryableFailedCount: parseInt(row.retryable_failed_count || 0, 10),
      totalEvents: parseInt(row.total_events || 0, 10),
      oldestPendingAt: row.oldest_pending_at || null,
    };
  }

  /**
   * Lists operational events for Admin UI inspection.
   * Strips raw tokens, credentials, and sensitive headers from payload.
   *
   * @param {object} [filters={}]
   * @param {string} [filters.status]
   * @param {string} [filters.eventType]
   * @param {number} [filters.limit=50]
   * @param {number} [filters.offset=0]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object[]>}
   */
  async listOperationalEvents(filters = {}, client = null) {
    if (mockOutboxResolver && mockOutboxResolver.listOperationalEvents) {
      return mockOutboxResolver.listOperationalEvents(filters, client);
    }

    const conditions = [];
    const values = [];

    if (filters.status) {
      values.push(filters.status.toUpperCase());
      conditions.push(`status = $${values.length}`);
    }

    if (filters.eventType) {
      values.push(filters.eventType);
      conditions.push(`event_type = $${values.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(100, Math.max(1, parseInt(filters.limit, 10) || 50));
    const offset = Math.max(0, parseInt(filters.offset, 10) || 0);

    values.push(limit);
    const limitParam = `$${values.length}`;
    values.push(offset);
    const offsetParam = `$${values.length}`;

    const sql = `
      SELECT
        id,
        event_type,
        aggregate_type,
        aggregate_id,
        status,
        retry_count,
        max_retries,
        next_retry_at,
        last_error,
        processed_at,
        created_at,
        locked_at,
        locked_by
      FROM outbox_events
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const res = client ? await client.query(sql, values) : await this.query(sql, values);
    return res.rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      status: row.status,
      retryCount: row.retry_count,
      maxRetries: row.max_retries,
      nextRetryAt: row.next_retry_at,
      lastError: row.last_error,
      processedAt: row.processed_at,
      createdAt: row.created_at,
      lockedAt: row.locked_at,
      lockedBy: row.locked_by,
    }));
  }

  /**
   * Safely cleans up processed outbox events older than the specified retention window.
   * Never deletes uncompleted events (PENDING, PROCESSING, FAILED).
   *
   * @param {number} [retentionDays=30]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<number>} Number of purged rows
   */
  async cleanupProcessedEvents(retentionDays = 30, client = null) {
    if (mockOutboxResolver && mockOutboxResolver.cleanupProcessedEvents) {
      return mockOutboxResolver.cleanupProcessedEvents(retentionDays, client);
    }

    const days = Math.max(7, parseInt(retentionDays, 10) || 30);

    const sql = `
      DELETE FROM outbox_events
      WHERE status = 'PROCESSED'
        AND processed_at < CURRENT_TIMESTAMP - ($1 || ' days')::interval;
    `;

    const res = client
      ? await client.query(sql, [String(days)])
      : await this.query(sql, [String(days)]);
    return res.rowCount || 0;
  }
}

module.exports = new AdminOutboxRepository();
