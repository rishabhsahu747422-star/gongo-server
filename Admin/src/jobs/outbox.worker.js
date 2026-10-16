'use strict';

const crypto = require('crypto');
const logger = require('../config/logger');
const adminOutboxRepository = require('../repositories/admin-outbox.repository');
const handlers = require('./handlers');
const { classifyError } = require('./utils/error-classifier');

/**
 * Production-Grade Outbox Background Worker.
 *
 * Guarantees:
 * - Database-safe row claiming using FOR UPDATE SKIP LOCKED
 * - Bounded retry policy with exponential backoff and jitter
 * - Complete worker error isolation (one failure never crashes the worker)
 * - Safe lease tracking and automated stale job recovery
 * - Graceful shutdown releasing all leases without data loss
 * - Operational health telemetry without secret leakage
 */
class OutboxWorker {
  /**
   * @param {object} [options={}]
   * @param {string} [options.workerId] Unique worker ID
   * @param {number} [options.batchSize=10] Max events per poll batch
   * @param {number} [options.pollIntervalMs=2000] Polling interval when active
   * @param {number} [options.maxPollIntervalMs=10000] Maximum backoff when queue is empty
   * @param {number} [options.leaseSeconds=300] Time before claimed job is considered stale
   * @param {number} [options.staleCheckIntervalMs=60000] Interval for stale job recovery scan
   * @param {number} [options.baseBackoffMs=1000] Base backoff delay for retries
   * @param {number} [options.maxBackoffMs=300000] Max retry delay cap
   * @param {object} [options.outboxRepo] Injected repository for testing
   */
  constructor(options = {}) {
    this.workerId = options.workerId
      || `admin-worker-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    this.batchSize = Math.min(100, Math.max(1, options.batchSize || 10));
    this.pollIntervalMs = Math.max(500, options.pollIntervalMs || 2000);
    this.maxPollIntervalMs = Math.max(this.pollIntervalMs, options.maxPollIntervalMs || 10000);
    this.currentPollDelayMs = this.pollIntervalMs;
    this.leaseSeconds = Math.max(30, options.leaseSeconds || 300);
    this.staleCheckIntervalMs = Math.max(5000, options.staleCheckIntervalMs || 60000);
    this.baseBackoffMs = options.baseBackoffMs || 1000;
    this.maxBackoffMs = options.maxBackoffMs || 300000;

    this.outboxRepo = options.outboxRepo || adminOutboxRepository;

    this.isRunning = false;
    this.isStopping = false;
    this.isProcessing = false;
    this.pollTimer = null;
    this.staleTimer = null;
    this.startTime = null;

    this.metrics = {
      lastPollAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      processedCount: 0,
      succeededCount: 0,
      failedCount: 0,
      retriedCount: 0,
    };

    this._inFlightPromise = null;
  }

  /**
   * Starts the background worker polling loop and stale recovery schedule.
   */
  start() {
    if (this.isRunning) {
      logger.warn('OutboxWorker is already running', { workerId: this.workerId });
      return;
    }

    this.isRunning = true;
    this.isStopping = false;
    this.startTime = Date.now();
    logger.info('Starting OutboxWorker', {
      workerId: this.workerId,
      batchSize: this.batchSize,
      pollIntervalMs: this.pollIntervalMs,
      leaseSeconds: this.leaseSeconds,
    });

    // Start polling loop
    this._scheduleNextPoll(0);

    // Start periodic stale job recovery loop
    this._scheduleStaleRecovery();
  }

  /**
   * Stops the background worker gracefully.
   * Drains in-flight operations and releases held leases.
   *
   * @param {number} [timeoutMs=10000] Maximum wait time for in-flight tasks
   */
  async stop(timeoutMs = 10000) {
    if (!this.isRunning && !this.isStopping) {
      return;
    }

    logger.info('Stopping OutboxWorker gracefully', { workerId: this.workerId });
    this.isRunning = false;
    this.isStopping = true;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }

    // Wait for current in-flight batch to conclude
    if (this._inFlightPromise) {
      try {
        const timeoutPromise = new Promise((resolve) => {
          setTimeout(resolve, timeoutMs);
        });
        await Promise.race([this._inFlightPromise, timeoutPromise]);
      } catch (err) {
        logger.error('Error waiting for in-flight batch on shutdown', { error: err.message });
      }
    }

    // Release any remaining leases held by this worker
    try {
      const releasedCount = await this.outboxRepo.releaseWorkerLeases(this.workerId);
      logger.info('Released worker leases on shutdown', {
        workerId: this.workerId,
        releasedCount,
      });
    } catch (releaseErr) {
      logger.error('Failed to release worker leases on shutdown', {
        workerId: this.workerId,
        error: releaseErr.message,
      });
    }

    logger.info('OutboxWorker stopped', { workerId: this.workerId });
  }

  /**
   * Schedules next execution of poll cycle.
   * @param {number} delayMs
   */
  _scheduleNextPoll(delayMs) {
    if (!this.isRunning) return;

    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null;
      if (!this.isRunning) return;

      this._inFlightPromise = this.pollOnce();
      try {
        await this._inFlightPromise;
      } finally {
        this._inFlightPromise = null;
      }

      if (this.isRunning) {
        this._scheduleNextPoll(this.currentPollDelayMs);
      }
    }, delayMs);

    if (this.pollTimer.unref) {
      this.pollTimer.unref();
    }
  }

  /**
   * Schedules periodic stale job recovery scan.
   */
  _scheduleStaleRecovery() {
    if (!this.isRunning) return;

    this.staleTimer = setInterval(async () => {
      if (!this.isRunning) return;
      try {
        const recoveredIds = await this.outboxRepo.recoverStaleJobs(this.leaseSeconds);
        if (recoveredIds.length > 0) {
          logger.info('Recovered stale outbox jobs back to PENDING', {
            workerId: this.workerId,
            count: recoveredIds.length,
            recoveredIds,
          });
        }
      } catch (err) {
        logger.error('Failed during stale job recovery scan', {
          workerId: this.workerId,
          error: err.message,
        });
      }
    }, this.staleCheckIntervalMs);

    if (this.staleTimer.unref) {
      this.staleTimer.unref();
    }
  }

  /**
   * Performs a single atomic poll, claims eligible jobs, and processes them.
   *
   * @returns {Promise<number>} Number of jobs processed in this cycle
   */
  async pollOnce() {
    this.metrics.lastPollAt = new Date().toISOString();

    let claimedEvents = [];
    try {
      claimedEvents = await this.outboxRepo.claimEvents({
        batchSize: this.batchSize,
        workerId: this.workerId,
        leaseSeconds: this.leaseSeconds,
      });
    } catch (err) {
      logger.error('Error claiming outbox events from database', {
        workerId: this.workerId,
        error: err.message,
      });
      // Back off on DB error
      this.currentPollDelayMs = Math.min(this.maxPollIntervalMs, this.currentPollDelayMs * 1.5);
      return 0;
    }

    if (!claimedEvents || claimedEvents.length === 0) {
      // Queue is empty: apply bounded backoff with slight jitter to prevent polling storm
      const jitterMs = Math.floor(Math.random() * 500);
      this.currentPollDelayMs = Math.min(
        this.maxPollIntervalMs,
        Math.round(this.currentPollDelayMs * 1.2) + jitterMs,
      );
      return 0;
    }

    // Work found: reset polling delay to base interval
    this.currentPollDelayMs = this.pollIntervalMs;

    // Process each claimed event independently (Isolation)
    /* eslint-disable no-restricted-syntax, no-await-in-loop */
    for (const event of claimedEvents) {
      if (this.isStopping) {
        logger.info('Worker shutdown requested during batch processing, stopping batch', {
          workerId: this.workerId,
        });
        break;
      }
      await this.processSingleEvent(event);
    }
    /* eslint-enable no-restricted-syntax, no-await-in-loop */

    return claimedEvents.length;
  }

  /**
   * Processes a single claimed outbox event with complete failure isolation.
   *
   * @param {object} event Outbox record
   */
  async processSingleEvent(event) {
    const start = Date.now();
    this.metrics.processedCount += 1;

    try {
      logger.info('Processing outbox event', {
        workerId: this.workerId,
        eventId: event.id,
        eventType: event.event_type,
        aggregateType: event.aggregate_type,
        aggregateId: event.aggregate_id,
        attempt: (event.retry_count || 0) + 1,
      });

      // Execute domain handler
      await handlers.dispatchEvent(event);

      // Transition to PROCESSED
      await this.outboxRepo.markProcessed(event.id);

      const durationMs = Date.now() - start;
      this.metrics.succeededCount += 1;
      this.metrics.lastSuccessAt = new Date().toISOString();

      logger.info('Successfully processed outbox event', {
        workerId: this.workerId,
        eventId: event.id,
        eventType: event.event_type,
        durationMs,
      });
    } catch (err) {
      const durationMs = Date.now() - start;
      const classification = classifyError(err);

      this.metrics.failedCount += 1;
      this.metrics.lastFailureAt = new Date().toISOString();

      if (classification.isRetryable) {
        this.metrics.retriedCount += 1;
      }

      logger.error('Failed to process outbox event', {
        workerId: this.workerId,
        eventId: event.id,
        eventType: event.event_type,
        category: classification.category,
        isRetryable: classification.isRetryable,
        durationMs,
        error: classification.message,
      });

      // Update failure state and schedule retry or dead-letter
      try {
        await this.outboxRepo.markFailed(event.id, err, {
          isRetryable: classification.isRetryable,
          baseBackoffMs: this.baseBackoffMs,
          maxBackoffMs: this.maxBackoffMs,
        });
      } catch (dbErr) {
        logger.error('CRITICAL: Failed to record outbox failure state in database', {
          eventId: event.id,
          dbError: dbErr.message,
        });
      }
    }
  }

  /**
   * Returns operational health statistics for worker monitoring.
   *
   * @returns {Promise<object>} Safe health payload
   */
  async getHealth() {
    let queueStats = null;
    try {
      queueStats = await this.outboxRepo.getQueueStats(this.leaseSeconds);
    } catch (err) {
      queueStats = { error: 'Failed to retrieve queue statistics' };
    }

    const uptimeSeconds = this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0;

    return {
      status: this.isRunning ? 'UP' : 'STOPPED',
      workerId: this.workerId,
      isRunning: this.isRunning,
      uptimeSeconds,
      config: {
        batchSize: this.batchSize,
        pollIntervalMs: this.pollIntervalMs,
        leaseSeconds: this.leaseSeconds,
      },
      metrics: {
        lastPollAt: this.metrics.lastPollAt,
        lastSuccessAt: this.metrics.lastSuccessAt,
        lastFailureAt: this.metrics.lastFailureAt,
        processedCount: this.metrics.processedCount,
        succeededCount: this.metrics.succeededCount,
        failedCount: this.metrics.failedCount,
        retriedCount: this.metrics.retriedCount,
      },
      queue: queueStats,
      timestamp: new Date().toISOString(),
    };
  }
}

const defaultWorker = new OutboxWorker();

module.exports = {
  OutboxWorker,
  defaultWorker,
};
