'use strict';

const crypto = require('crypto');
const { pool, logger } = require('../config');
const cashfreeProvider = require('./payment/providers/cashfree.provider');
const notificationService = require('./notification.service');
const { NOTIFICATION_TYPES } = require('../constants/notification');
const { PAYMENT_STATUS } = require('../constants/payment');

async function withSavepoint(client, name, fn) {
  await client.query(`SAVEPOINT ${name}`);
  try {
    const res = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return res;
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    throw err;
  }
}

/**
 * Service orchestrating automatic 5-minute payment timeout cancellations.
 *
 * Business Rule:
 * For payment attempts that remain genuinely unpaid or pending:
 * - The 5-minute deadline begins ONLY after actual payment initiation has been recorded by the backend.
 * - If no verified successful payment exists after the deadline, automatically cancel the eligible booking on the backend.
 * - The backend timeout works even if the customer closes the app or loses connectivity.
 * - A booking that never entered payment initiation is NOT selected by this query.
 * - Enquiries and availability/pricing checks are unaffected.
 * - Does not extend the original deadline on retries or screen reopen.
 * - Uses row-level locking (FOR UPDATE OF b, p SKIP LOCKED) to guarantee atomicity and prevent race conditions.
 */
class PaymentTimeoutService {
  constructor(deps = {}) {
    this.pool = deps.pool || pool;
    this.logger = deps.logger || logger;
    this.provider = deps.provider || cashfreeProvider;
    this.notificationService = deps.notificationService || notificationService;
    this.defaultTimeoutMs = deps.timeoutMs || Number(process.env.PAYMENT_TIMEOUT_MS || (5 * 60 * 1000));

    this.timer = null;
    this.isProcessing = false;
    this.isShuttingDown = false;
    this.activeRunPromise = null;
  }

  /**
   * Identifies and auto-cancels all eligible expired payment bookings.
   *
   * @param {number} [batchSize=50]
   * @param {number|null} [overrideTimeoutMs=null] - Optional override for testing
   * @returns {Promise<{ processed: number, cancelled: Array<object> }>}
   */
  async processExpiredPaymentBookings(batchSize = 50, overrideTimeoutMs = null) {
    if (this.isShuttingDown) {
      return { processed: 0, cancelled: [] };
    }

    const timeoutDuration = overrideTimeoutMs !== null && overrideTimeoutMs !== undefined
      ? overrideTimeoutMs
      : this.defaultTimeoutMs;
    const cutoffTimestamp = new Date(Date.now() - timeoutDuration);

    const client = await this.pool.connect();
    const cancelledResults = [];

    try {
      await client.query('BEGIN');

      // Select bookings where:
      // 1. Payment initiation exists (p.payment_type = 'BOOKING_ADVANCE') and was created before cutoff
      // 2. Payment status is still initiated / pending
      // 3. Booking is still in pre-confirmation / payment pending state
      // 4. NO verified successful payment exists for this booking
      // 5. Uses FOR UPDATE OF b, p SKIP LOCKED for concurrency safety
      const query = `
        SELECT 
          b.id AS booking_id,
          b.booking_number,
          b.booking_reference,
          b.customer_id,
          b.partner_id,
          b.vehicle_id,
          b.status AS booking_status,
          p.id AS payment_id,
          p.provider_order_id,
          p.amount,
          p.currency,
          p.status AS payment_status,
          p.created_at AS payment_initiated_at
        FROM bookings b
        JOIN payments p ON p.booking_id = b.id AND (p.payment_type = 'BOOKING_ADVANCE' OR p.payment_type IS NULL)
        WHERE p.created_at <= $1
          AND p.status IN ('initiated', 'pending', 'CREATED', 'PENDING')
          AND b.status IN ('payment_pending', 'initiated', 'PAYMENT_PENDING', 'PENDING')
          AND NOT EXISTS (
            SELECT 1 FROM payments p2
            WHERE p2.booking_id = b.id
              AND p2.status IN ('paid', 'success', 'PAID', 'SUCCESS')
          )
        ORDER BY p.created_at ASC
        LIMIT $2
        FOR UPDATE OF b, p SKIP LOCKED;
      `;

      const { rows: eligibleCandidates } = await client.query(query, [cutoffTimestamp, batchSize]);

      for (const candidate of eligibleCandidates) {
        // Re-check that no successful payment exists
        const successCheck = await client.query(
          `SELECT 1 FROM payments
           WHERE booking_id = $1
             AND status IN ('paid', 'success', 'PAID', 'SUCCESS')
           LIMIT 1`,
          [candidate.booking_id],
        );
        if (successCheck.rows.length > 0) {
          continue;
        }

        // Check authoritative order status from Cashfree provider if provider_order_id exists
        let isDefinitivelyPaid = false;
        let providerUnreachable = false;

        if (candidate.provider_order_id) {
          try {
            const providerStatus = await this.provider.getOrderStatus(candidate.provider_order_id);
            if (providerStatus && (providerStatus.orderStatus === 'PAID' || providerStatus.orderStatus === 'SUCCESS')) {
              isDefinitivelyPaid = true;
            }
          } catch (err) {
            // If provider is temporarily unreachable, do NOT prematurely cancel on transient network error
            if (err.name === 'ServiceUnavailableError' || err.code === 'ECONNREFUSED' || err.name === 'AbortError') {
              this.logger.warn('Provider status check temporarily unavailable during timeout evaluation — deferring', {
                bookingId: candidate.booking_id,
                error: err.message,
              });
              providerUnreachable = true;
            }
          }
        }

        if (providerUnreachable) {
          // Defer to next run to avoid premature cancellation on network blips
          continue;
        }

        if (isDefinitivelyPaid) {
          // The payment was actually captured! Confirm booking, do not cancel
          this.logger.info('Timeout job detected paid order from provider — confirming booking instead of cancelling', {
            bookingId: candidate.booking_id,
            paymentId: candidate.payment_id,
          });

          await client.query(
            `UPDATE payments
             SET status = 'paid', updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [candidate.payment_id],
          );

          try {
            await withSavepoint(client, 'sp_paid_booking_update', () => client.query(
              `UPDATE bookings
               SET status = 'payment_completed',
                   booking_status = 'CONFIRMED',
                   payment_status = 'PAID',
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = $1`,
              [candidate.booking_id],
            ));
          } catch (_) {
            await client.query(
              `UPDATE bookings
               SET status = 'payment_completed',
                   payment_status = 'PAID',
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = $1`,
              [candidate.booking_id],
            );
          }

          try {
            await withSavepoint(client, 'sp_paid_vehicle_update', () => client.query(
              `UPDATE vehicles
               SET rental_status = 'BOOKED', updated_at = CURRENT_TIMESTAMP
               WHERE id = $1`,
              [candidate.vehicle_id],
            ));
          } catch (_) {}

          continue;
        }

        // Definitively cancel the eligible booking due to 5-minute payment timeout
        const cancellationReason = 'PAYMENT_TIMEOUT';
        const displayRef = candidate.booking_reference || candidate.booking_number || candidate.booking_id;

        // 1. Mark payment as FAILED with PAYMENT_TIMEOUT
        await client.query(
          `UPDATE payments
           SET status = 'failed',
               failure_reason = $1,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [cancellationReason, candidate.payment_id],
        );

        // 2. Transition booking to cancelled
        try {
          await withSavepoint(client, 'sp_cancel_booking_update', () => client.query(
            `UPDATE bookings
             SET status = 'cancelled',
                 booking_status = 'CANCELLED',
                 cancellation_reason = $1,
                 cancelled_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [cancellationReason, candidate.booking_id],
          ));
        } catch (_) {
          await client.query(
            `UPDATE bookings
             SET status = 'cancelled',
                 cancellation_reason = $1,
                 cancelled_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [cancellationReason, candidate.booking_id],
          );
        }

        // 3. Upsert into booking_cancellations
        try {
          await withSavepoint(client, 'sp_booking_cancellations_insert', () => client.query(
            `INSERT INTO booking_cancellations (
               booking_id, cancelled_by, cancellation_reason, cancelled_at
             ) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
             ON CONFLICT (booking_id) DO UPDATE
             SET cancellation_reason = EXCLUDED.cancellation_reason,
                 cancelled_at = EXCLUDED.cancelled_at`,
            [candidate.booking_id, candidate.customer_id, cancellationReason],
          ));
        } catch (_) {
          // Non-fatal if table schema differs
        }

        // 4. Release vehicle availability to IDLE
        try {
          await withSavepoint(client, 'sp_vehicle_idle', () => client.query(
            `UPDATE vehicles
             SET rental_status = 'IDLE', updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND rental_status != 'ACTIVE'`,
            [candidate.vehicle_id],
          ));
        } catch (_) {
          // Non-fatal if column absent
        }

        // 5. Insert into booking_status_history
        try {
          await withSavepoint(client, 'sp_status_history_insert', () => client.query(
            `INSERT INTO booking_status_history (
               id, booking_id, old_status, new_status, changed_by, change_reason, created_at
             ) VALUES (gen_random_uuid(), $1, $2, 'cancelled', NULL, $3, CURRENT_TIMESTAMP)`,
            [candidate.booking_id, candidate.booking_status, cancellationReason],
          ));
        } catch (_) {
          // Non-fatal
        }

        // 6. Push notification to customer
        try {
          await this.notificationService.sendNotification({
            customerId: candidate.customer_id,
            type: NOTIFICATION_TYPES.BOOKING_CANCELLED,
            title: 'Booking Cancelled',
            body: `Your booking (${displayRef}) was cancelled because payment was not completed within 5 minutes.`,
            data: {
              bookingId: candidate.booking_id,
              paymentId: candidate.payment_id,
              reason: cancellationReason,
            },
            eventKey: `BOOKING_CANCELLED:payment_timeout:${candidate.booking_id}`,
          });
        } catch (notifErr) {
          this.logger.warn('Failed to send payment timeout notification', {
            bookingId: candidate.booking_id,
            error: notifErr.message,
          });
        }

        cancelledResults.push({
          id: candidate.booking_id,
          bookingReference: displayRef,
          paymentId: candidate.payment_id,
          reason: cancellationReason,
        });
      }

      await client.query('COMMIT');

      if (cancelledResults.length > 0) {
        this.logger.info(`Auto-cancelled ${cancelledResults.length} expired unpaid booking(s) after 5-minute timeout`, {
          count: cancelledResults.length,
          bookingIds: cancelledResults.map((r) => r.id),
        });
      }

      return {
        processed: eligibleCandidates.length,
        cancelled: cancelledResults,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      this.logger.error('Error during auto-cancellation of expired payment bookings', {
        error: err.message,
      });
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Starts periodic background worker scheduler.
   *
   * @param {number} [intervalMs=30000] Default: runs every 30 seconds
   */
  startScheduler(intervalMs = 30000) {
    if (this.timer) {
      return;
    }

    this.isShuttingDown = false;
    this.logger.info(`Starting Payment Timeout Auto-Cancellation scheduler (interval: ${intervalMs}ms)`);

    const executeCycle = async () => {
      if (this.isProcessing || this.isShuttingDown) {
        return;
      }
      this.isProcessing = true;
      try {
        this.activeRunPromise = this.processExpiredPaymentBookings(50);
        await this.activeRunPromise;
      } catch (err) {
        this.logger.error('Payment Timeout cycle failed', { error: err.message });
      } finally {
        this.isProcessing = false;
        this.activeRunPromise = null;
      }
    };

    // Initial check shortly after startup
    setTimeout(() => {
      executeCycle().catch(() => {});
    }, 3000);

    this.timer = setInterval(executeCycle, intervalMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  /**
   * Stops the background scheduler cleanly.
   */
  async stopScheduler() {
    this.isShuttingDown = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.activeRunPromise) {
      try {
        await this.activeRunPromise;
      } catch (_) {}
    }
    this.logger.info('Payment Timeout Auto-Cancellation scheduler stopped');
  }
}

const paymentTimeoutService = new PaymentTimeoutService();
paymentTimeoutService.PaymentTimeoutService = PaymentTimeoutService;

module.exports = paymentTimeoutService;
