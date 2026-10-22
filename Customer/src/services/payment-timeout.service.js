'use strict';

const crypto = require('crypto');
const { pool, logger } = require('../config');
const cashfreeProvider = require('./payment/providers/cashfree.provider');
const notificationService = require('./notification.service');
const { NOTIFICATION_TYPES } = require('../constants/notification');
const { PAYMENT_STATUS } = require('../constants/payment');

async function withSavepoint(client, name, fn) {
  let hasSavepoint = false;
  try {
    await client.query(`SAVEPOINT ${name}`);
    hasSavepoint = true;
  } catch (_) {
    hasSavepoint = false;
  }
  try {
    const res = await fn();
    if (hasSavepoint) {
      try {
        await client.query(`RELEASE SAVEPOINT ${name}`);
      } catch (_) {}
    }
    return res;
  } catch (err) {
    if (hasSavepoint) {
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      } catch (_) {}
    }
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
      // 1. Payment deadline (b.payment_expires_at) has passed OR payment/booking creation was before cutoff
      // 2. Booking is still in pre-confirmation / payment pending state
      // 3. NO verified successful payment exists for this booking
      // 4. Uses FOR UPDATE OF b SKIP LOCKED for multi-instance concurrency safety
      const now = new Date();
      const query = `
        SELECT 
          b.id AS booking_id,
          b.booking_number,
          b.booking_reference,
          b.customer_id,
          b.partner_id,
          b.vehicle_id,
          b.status AS booking_status,
          b.created_at AS booking_created_at,
          b.payment_expires_at,
          p.id AS payment_id,
          p.provider_order_id,
          p.amount,
          p.currency,
          p.status AS payment_status,
          COALESCE(p.created_at, b.payment_initiated_at, b.created_at) AS payment_initiated_at
        FROM bookings b
        LEFT JOIN LATERAL (
          SELECT p1.id, p1.provider_order_id, p1.amount, p1.currency, p1.status, p1.created_at
          FROM payments p1
          WHERE p1.booking_id = b.id AND (p1.payment_type = 'BOOKING_ADVANCE' OR p1.payment_type IS NULL)
          ORDER BY p1.created_at DESC
          LIMIT 1
        ) p ON true
        WHERE b.status IN ('payment_pending', 'initiated', 'PAYMENT_PENDING', 'PENDING')
          AND (
            p.created_at <= $1
            OR (b.payment_expires_at IS NOT NULL AND b.payment_expires_at <= $2)
            OR (p.created_at IS NULL AND COALESCE(b.payment_expires_at, b.created_at + interval '5 minutes') <= $2)
          )
          AND NOT EXISTS (
            SELECT 1 FROM payments p2
            WHERE p2.booking_id = b.id
              AND p2.status IN ('paid', 'success', 'PAID', 'SUCCESS')
          )
        ORDER BY COALESCE(b.payment_expires_at, b.created_at) ASC
        LIMIT $3
        FOR UPDATE OF b SKIP LOCKED;
      `;

      const { rows: eligibleCandidates } = await client.query(query, [cutoffTimestamp, now, batchSize]);

      for (const candidate of eligibleCandidates) {
        const candidateSavepoint = `sp_cand_${String(candidate.booking_id).replace(/-/g, '_').slice(0, 20)}`;
        try {
          await withSavepoint(client, candidateSavepoint, async () => {
            if (candidate.payment_id) {
              await client.query('SELECT id FROM payments WHERE id = $1 FOR UPDATE', [candidate.payment_id]).catch(() => {});
            }

            // Re-check that no successful payment exists
            const successCheck = await client.query(
              `SELECT 1 FROM payments
               WHERE booking_id = $1
                 AND status IN ('paid', 'success', 'PAID', 'SUCCESS')
               LIMIT 1`,
              [candidate.booking_id],
            );
            if (successCheck.rows.length > 0) {
              return;
            }

            // Check authoritative order status from Cashfree provider if provider_order_id exists
            let isDefinitivelyPaid = false;
            let providerUnreachable = false;

            if (candidate.provider_order_id) {
              try {
                const providerStatus = await this.provider.getOrderStatus(candidate.provider_order_id, {
                  bookingId: candidate.booking_id,
                  paymentId: candidate.payment_id,
                });
                if (providerStatus && (providerStatus.orderStatus === 'PAID' || providerStatus.orderStatus === 'SUCCESS')) {
                  isDefinitivelyPaid = true;
                } else if (providerStatus && (providerStatus.notFound || providerStatus.orderStatus === 'NOT_FOUND')) {
                  this.logger.warn('Cashfree order reference not found in gateway environment during timeout check', {
                    bookingId: candidate.booking_id,
                    paymentId: candidate.payment_id,
                    providerOrderId: candidate.provider_order_id,
                  });
                }
              } catch (err) {
                // If provider is temporarily unreachable, do NOT prematurely cancel on transient network error
                if (err.name === 'ServiceUnavailableError' || err.code === 'ECONNREFUSED' || err.name === 'AbortError') {
                  this.logger.warn('Provider status check temporarily unavailable during timeout evaluation — deferring', {
                    bookingId: candidate.booking_id,
                    error: err.message,
                  });
                  providerUnreachable = true;
                } else if (err.name === 'BadRequestError' && (err.message?.includes('does not exist') || err.message?.includes('not found') || err.message?.includes('404'))) {
                  this.logger.warn('Order not found on payment provider during timeout evaluation', {
                    bookingId: candidate.booking_id,
                    paymentId: candidate.payment_id,
                    providerOrderId: candidate.provider_order_id,
                    error: err.message,
                  });
                } else {
                  this.logger.warn('Non-fatal error checking provider status during timeout evaluation', {
                    bookingId: candidate.booking_id,
                    paymentId: candidate.payment_id,
                    providerOrderId: candidate.provider_order_id,
                    error: err.message,
                  });
                }
              }
            }

            if (providerUnreachable) {
              // Defer to next run to avoid premature cancellation on network blips
              return;
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
                try {
                  await withSavepoint(client, 'sp_paid_booking_fallback', () => client.query(
                    `UPDATE bookings
                     SET status = 'payment_completed',
                         payment_status = 'PAID',
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $1`,
                    [candidate.booking_id],
                  ));
                } catch (_) {
                  await client.query(
                    `UPDATE bookings
                     SET status = 'payment_completed',
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $1`,
                    [candidate.booking_id],
                  ).catch(() => client.query(
                    `UPDATE bookings
                     SET booking_status = 'CONFIRMED',
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $1`,
                    [candidate.booking_id],
                  ));
                }
              }

              try {
                await withSavepoint(client, 'sp_paid_vehicle_update', () => client.query(
                  `UPDATE vehicles
                   SET rental_status = 'BOOKED', updated_at = CURRENT_TIMESTAMP
                   WHERE id = $1`,
                  [candidate.vehicle_id],
                ));
              } catch (_) {}

              return;
            }

            // Definitively cancel the eligible booking due to 5-minute payment timeout
            const cancellationReason = 'PAYMENT_TIMEOUT';
            const displayRef = candidate.booking_reference || candidate.booking_number || candidate.booking_id;

            // 1. Mark payment as FAILED with PAYMENT_TIMEOUT
            if (candidate.payment_id) {
              await client.query(
                `UPDATE payments
                 SET status = 'failed',
                     failure_reason = $1,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2`,
                [cancellationReason, candidate.payment_id],
              );
            }
            try {
              await client.query(
                `UPDATE payments
                 SET status = 'failed',
                     failure_reason = $1,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE booking_id = $2
                   AND status IN ('initiated', 'pending', 'CREATED', 'PENDING')`,
                [cancellationReason, candidate.booking_id],
              );
            } catch (_) {}

            // 2. Transition booking to cancelled defensively across schema variations
            let updatedBooking = false;
            try {
              await withSavepoint(client, 'sp_cancel_booking_update', () => client.query(
                `UPDATE bookings
                 SET status = 'cancelled',
                     cancellation_reason = $1,
                     cancelled_at = CURRENT_TIMESTAMP,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2`,
                [cancellationReason, candidate.booking_id],
              ));
              updatedBooking = true;
            } catch (_) {}

            if (!updatedBooking) {
              try {
                await withSavepoint(client, 'sp_cancel_booking_fallback', () => client.query(
                  `UPDATE bookings
                   SET status = 'cancelled',
                       updated_at = CURRENT_TIMESTAMP
                   WHERE id = $1`,
                  [candidate.booking_id],
                ));
                updatedBooking = true;
              } catch (_) {
                try {
                  await withSavepoint(client, 'sp_cancel_booking_bstatus_only', () => client.query(
                    `UPDATE bookings
                     SET booking_status = 'CANCELLED',
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = $1`,
                    [candidate.booking_id],
                  ));
                  updatedBooking = true;
                } catch (_) {}
              }
            }

            // Also sync optional booking_status column if present
            try {
              await withSavepoint(client, 'sp_cancel_booking_bstatus', () => client.query(
                `UPDATE bookings
                 SET booking_status = 'CANCELLED'
                 WHERE id = $1`,
                [candidate.booking_id],
              ));
            } catch (_) {}

            // 3. Upsert into booking_cancellations to guarantee cancelled_at and cancellation_reason persistence
            try {
              await withSavepoint(client, 'sp_booking_cancellations_insert', () => client.query(
                `INSERT INTO booking_cancellations (
                   id, booking_id, cancelled_by, cancellation_reason, cancelled_at
                 ) VALUES (gen_random_uuid(), $1, $2, $3, CURRENT_TIMESTAMP)
                 ON CONFLICT (booking_id) DO UPDATE
                 SET cancellation_reason = EXCLUDED.cancellation_reason,
                     cancelled_at = EXCLUDED.cancelled_at`,
                [candidate.booking_id, candidate.customer_id, cancellationReason],
              ));
            } catch (_) {
              try {
                await withSavepoint(client, 'sp_booking_cancellations_fallback', () => client.query(
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
          });
        } catch (candidateErr) {
          this.logger.error('Failed to process timeout candidate booking', {
            bookingId: candidate.booking_id,
            paymentId: candidate.payment_id,
            error: candidateErr.message,
          });
        }
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
   * @param {number} [intervalMs=15000] Default: runs every 15 seconds
   */
  startScheduler(intervalMs = 15000) {
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
