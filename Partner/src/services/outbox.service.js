'use strict';

/* eslint-disable no-await-in-loop */
const OutboxRepository = require('../repositories/outbox.repository');
const NotificationRepository = require('../repositories/notification.repository');
const { pool } = require('../db/pool');
const logger = require('../config/logger');

/**
 * Service managing transactional outbox events and asynchronous reliable dispatching.
 */
class OutboxService {
  constructor(
    outboxRepo = new OutboxRepository(),
    notificationRepo = new NotificationRepository(),
    dbPool = pool,
  ) {
    this.outboxRepository = outboxRepo;
    this.notificationRepository = notificationRepo;
    this.pool = dbPool;
    this.pollInterval = null;
    this.isProcessing = false;
    this.isShuttingDown = false;
  }

  /**
   * Records an outbox event atomically within a business transaction.
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
  async recordEvent(params, client = null) {
    const event = await this.outboxRepository.createEvent(params, client);
    if (this.pollInterval) {
      setImmediate(() => {
        this.processBatch(10).catch(() => {});
      });
    }
    return event;
  }

  /**
   * Processes a single batch of pending/retryable outbox events.
   *
   * @param {number} [batchSize=10]
   * @returns {Promise<{ processed: number, succeeded: number, failed: number }>}
   */
  async processBatch(batchSize = 10) {
    if (this.isProcessing || this.isShuttingDown) {
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    this.isProcessing = true;
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    let client;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');

      const events = await this.outboxRepository.fetchPendingEvents(batchSize, client);
      processed = events.length;

      if (processed === 0) {
        await client.query('ROLLBACK');
        return { processed: 0, succeeded: 0, failed: 0 };
      }

      for (let i = 0; i < events.length; i += 1) {
        const event = events[i];
        // Per-event savepoint: a failing handler aborts only its own statements, so the
        // batch can still record markFailed and commit instead of rolling back and
        // retrying the same poison event on every tick. Skipped if the driver lacks
        // savepoint support (pg-mem in tests).
        let hasSavepoint = false;
        try {
          await client.query('SAVEPOINT outbox_event');
          hasSavepoint = true;
        } catch (_) {
          hasSavepoint = false;
        }
        try {
          // Dispatch event to appropriate handlers
          await this.dispatchHandler(event, client);
          await this.outboxRepository.markCompleted(event.id, client);
          if (hasSavepoint) await client.query('RELEASE SAVEPOINT outbox_event');
          succeeded += 1;
        } catch (dispatchErr) {
          logger.warn('Failed to dispatch outbox event, scheduling retry', {
            eventId: event.id,
            eventType: event.event_type,
            error: dispatchErr.message,
          });
          if (hasSavepoint) await client.query('ROLLBACK TO SAVEPOINT outbox_event');
          await this.outboxRepository.markFailed(event.id, dispatchErr, client);
          failed += 1;
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch (_) {
          // Ignore rollback failure
        }
      }
      logger.error('Error during outbox batch processing', { error: err.message });
    } finally {
      if (client) {
        client.release();
      }
      this.isProcessing = false;
    }

    return { processed, succeeded, failed };
  }

  /**
   * Route event to relevant consumer based on event_type.
   *
   * @param {object} event
   * @param {import('pg').PoolClient} client
   */
  async dispatchHandler(event, client) {
    const payload = typeof event.payload === 'string'
      ? JSON.parse(event.payload)
      : (event.payload || {});

    switch (event.event_type) {
      case 'PAYOUT_COMPLETED': {
        const partnerId = payload.partnerId || event.aggregate_id;
        const amount = Number(payload.amount || 0).toFixed(2);
        await this.notificationRepository.createNotification({
          partnerId,
          type: 'PAYOUT_COMPLETED',
          title: 'Payout Disbursed',
          body: `Your payout withdrawal of ₹${amount} has been successfully transferred to your bank account.`,
          payload: { payoutId: payload.payoutId || event.aggregate_id, amount: payload.amount },
          eventKey: `PAYOUT_COMPLETED:${event.aggregate_id}`,
        }, client);
        break;
      }

      case 'PAYOUT_FAILED': {
        const partnerId = payload.partnerId || event.aggregate_id;
        const amount = Number(payload.amount || 0).toFixed(2);
        const reason = payload.failureReason || 'Processing issue';
        await this.notificationRepository.createNotification({
          partnerId,
          type: 'PAYOUT_FAILED',
          title: 'Payout Failed & Balance Restored',
          body: `Your payout withdrawal of ₹${amount} could not be processed: ${reason}. The amount has been credited back to your wallet.`,
          payload: {
            payoutId: payload.payoutId || event.aggregate_id,
            amount: payload.amount,
            reason,
          },
          eventKey: `PAYOUT_FAILED:${event.aggregate_id}`,
        }, client);
        break;
      }

      case 'PAYOUT_REVERSED': {
        const partnerId = payload.partnerId || event.aggregate_id;
        const amount = Number(payload.amount || 0).toFixed(2);
        await this.notificationRepository.createNotification({
          partnerId,
          type: 'PAYOUT_REVERSED',
          title: 'Payout Reversed & Refunded',
          body: `Your payout withdrawal of ₹${amount} was reversed by the banking provider and credited back to your wallet balance.`,
          payload: { payoutId: payload.payoutId || event.aggregate_id, amount: payload.amount },
          eventKey: `PAYOUT_REVERSED:${event.aggregate_id}`,
        }, client);
        break;
      }

      case 'SETTLEMENT_RECEIVED': {
        const partnerId = payload.partnerId || event.aggregate_id;
        const amount = Number(payload.amount || 0).toFixed(2);
        await this.notificationRepository.createNotification({
          partnerId,
          type: 'SETTLEMENT_RECEIVED',
          title: 'Settlement Payment Credited',
          body: `Post-rental settlement of ₹${amount} has been credited to your wallet.`,
          payload: {
            paymentId: payload.paymentId,
            bookingId: payload.bookingId,
            amount: payload.amount,
          },
          eventKey: `SETTLEMENT_RECEIVED:${payload.paymentId || event.aggregate_id}`,
        }, client);
        break;
      }

      case 'EARNING_CREDITED': {
        const partnerId = payload.partnerId || event.aggregate_id;
        const netAmount = Number(payload.partnerNetAmount || payload.amount || 0).toFixed(2);
        await this.notificationRepository.createNotification({
          partnerId,
          type: 'EARNING_CREDITED',
          title: 'Rental Earnings Credited',
          body: `Rental earnings of ₹${netAmount} have been credited to your wallet balance.`,
          payload: {
            bookingId: payload.bookingId,
            earningId: payload.earningId,
            amount: netAmount,
          },
          eventKey: `EARNING_CREDITED:${payload.bookingId || event.aggregate_id}`,
        }, client);
        break;
      }

      case 'DAMAGE_SETTLED': {
        const partnerId = payload.partnerId || event.aggregate_id;
        const amount = Number(payload.approvedAmount || payload.amount || 0).toFixed(2);
        await this.notificationRepository.createNotification({
          partnerId,
          type: 'DAMAGE_SETTLED',
          title: 'Damage Claim Settled',
          body: `Damage claim of ₹${amount} has been settled and credited to your wallet.`,
          payload: {
            damageId: payload.damageId || event.aggregate_id,
            bookingId: payload.bookingId,
            amount,
          },
          eventKey: `DAMAGE_SETTLED:${payload.damageId || event.aggregate_id}`,
        }, client);
        break;
      }

      default: {
        logger.info('Outbox event processed without dedicated notification handler', {
          eventType: event.event_type,
          aggregateId: event.aggregate_id,
        });
        break;
      }
    }
  }

  /**
   * Starts background outbox worker.
   *
   * @param {number} [intervalMs=5000]
   */
  startWorker(intervalMs = 15000) {
    if (this.pollInterval) return;

    this.isShuttingDown = false;
    this.pollInterval = setInterval(async () => {
      try {
        await this.processBatch(20);
      } catch (err) {
        logger.error('Outbox worker tick error', { error: err.message });
      }
    }, intervalMs);

    if (this.pollInterval.unref) {
      this.pollInterval.unref();
    }

    logger.info(`Outbox worker started with interval ${intervalMs}ms`);
  }

  /**
   * Stops background worker cleanly for graceful shutdown.
   */
  async stopWorker() {
    this.isShuttingDown = true;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    // Wait if currently processing
    let attempts = 0;
    while (this.isProcessing && attempts < 20) {
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      attempts += 1;
    }

    logger.info('Outbox worker stopped gracefully');
  }

  /**
   * Gets operational statistics for outbox events.
   *
   * @returns {Promise<object>}
   */
  async getStats() {
    return this.outboxRepository.getOutboxStats();
  }
}

module.exports = new OutboxService();
