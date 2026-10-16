'use strict';

const crypto = require('crypto');
const { pool, redisClient, logger } = require('../config');
const notificationService = require('./notification.service');
const { NOTIFICATION_TYPES } = require('../constants/notification');

/**
 * Service orchestrating automatic no-show / auto-cancellation for bookings
 * where the scheduled return time has passed and vehicle handover never occurred.
 *
 * Business Rule:
 * If a customer books a vehicle for a specific rental period and NEVER completes
 * vehicle handover/pickup, then the booking must automatically expire/cancel
 * at the scheduled RETURN time with zero grace period.
 */
class NoShowAutoCancellationService {
  constructor(deps = {}) {
    this.pool = deps.pool || pool;
    this.redisClient = deps.redisClient || redisClient;
    this.logger = deps.logger || logger;
    this.notificationService = deps.notificationService || notificationService;

    this.timer = null;
    this.isProcessing = false;
    this.isShuttingDown = false;
    this.activeRunPromise = null;
  }

  /**
   * Identifies and auto-cancels all eligible expired bookings.
   * Uses row-level locking (FOR UPDATE SKIP LOCKED) to guarantee atomicity
   * and prevent race conditions with concurrent pickup verification.
   *
   * @param {number} [batchSize=50]
   * @returns {Promise<{ processed: number, cancelled: Array<object> }>}
   */
  async processExpiredBookings(batchSize = 50) {
    if (this.isShuttingDown) {
      return { processed: 0, cancelled: [] };
    }

    const client = await this.pool.connect();
    const cancelledResults = [];

    try {
      await client.query('BEGIN');

      // Find bookings where:
      // 1. Scheduled return time has been reached or passed
      // 2. Booking is in pre-handover state (confirmed, pickup_scheduled, payment_completed, initiated)
      // 3. Handover has NOT occurred (no verified pickup verification or pickup record)
      // 4. Not already active, completed, or cancelled
      const query = `
        SELECT 
          b.id,
          b.booking_number,
          b.booking_reference,
          b.customer_id,
          b.partner_id,
          b.vehicle_id,
          b.shop_id,
          b.start_at,
          b.end_at,
          b.expected_return_at,
          b.status,
          b.booking_status,
          b.payment_status,
          b.subtotal,
          b.total_amount
        FROM bookings b
        WHERE COALESCE(b.expected_return_at, b.end_at) <= CURRENT_TIMESTAMP
          AND b.status IN ('confirmed', 'pickup_scheduled', 'payment_completed', 'initiated')
          AND UPPER(COALESCE(b.booking_status, '')) NOT IN ('ACTIVE', 'COMPLETED', 'CANCELLED', 'REFUNDED')
          AND NOT EXISTS (
            SELECT 1 FROM booking_pickup_verifications bpv 
            WHERE bpv.booking_id = b.id AND bpv.is_verified = TRUE
          )
          AND NOT EXISTS (
            SELECT 1 FROM booking_pickup bp 
            WHERE bp.booking_id = b.id AND bp.picked_up_at IS NOT NULL
          )
        ORDER BY COALESCE(b.expected_return_at, b.end_at) ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED;
      `;

      const { rows: eligibleBookings } = await client.query(query, [batchSize]);

      for (const booking of eligibleBookings) {
        // Re-verify inside locked transaction
        const verifyRes = await client.query(
          `SELECT 
             b.status,
             b.booking_status,
             EXISTS (
               SELECT 1 FROM booking_pickup_verifications bpv 
               WHERE bpv.booking_id = b.id AND bpv.is_verified = TRUE
             ) AS is_verified,
             EXISTS (
               SELECT 1 FROM booking_pickup bp 
               WHERE bp.booking_id = b.id AND bp.picked_up_at IS NOT NULL
             ) AS is_picked_up
           FROM bookings b
           WHERE b.id = $1`,
          [booking.id],
        );

        const current = verifyRes.rows[0];
        if (!current) continue;

        const currentStatus = String(current.status || '').toLowerCase();
        const currentBookingStatus = String(current.booking_status || '').toUpperCase();

        // Skip if concurrent transaction already completed handover or cancelled
        if (
          currentStatus === 'cancelled' ||
          currentBookingStatus === 'CANCELLED' ||
          currentStatus === 'in_progress' ||
          currentBookingStatus === 'ACTIVE' ||
          current.is_verified ||
          current.is_picked_up
        ) {
          continue;
        }

        // Determine online paid amount (excluding security deposit)
        let originalPaidAmount = 0;
        try {
          const payRes = await client.query(
            `SELECT amount FROM payments 
             WHERE booking_id = $1 
               AND status IN ('COMPLETED', 'PAID', 'SUCCESS', 'completed', 'paid', 'success')
               AND (payment_type = 'BOOKING_ADVANCE' OR payment_type IS NULL)
             ORDER BY created_at DESC LIMIT 1`,
            [booking.id],
          );
          if (payRes.rows[0] && Number(payRes.rows[0].amount) > 0) {
            originalPaidAmount = Number(payRes.rows[0].amount);
          } else {
            originalPaidAmount = Math.max(0, Number(booking.subtotal || booking.total_amount || 0));
          }
        } catch (_) {
          originalPaidAmount = Math.max(0, Number(booking.subtotal || booking.total_amount || 0));
        }

        const cancellationId = crypto.randomUUID();
        const auditLogId = crypto.randomUUID();
        const partnerNotifId = crypto.randomUUID();
        const eventKey = `NO_SHOW_EXPIRED:booking:${booking.id}`;
        const displayRef = booking.booking_reference || booking.booking_number || booking.id;

        // 1. Transition booking status to CANCELLED
        await client.query(
          `UPDATE bookings
           SET status = 'cancelled',
               booking_status = 'CANCELLED',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [booking.id],
        );

        // 2. Insert into booking_status_history
        await client.query(
          `INSERT INTO booking_status_history (
             id, booking_id, old_status, new_status, changed_by, change_reason, created_at
           ) VALUES (
             $1, $2, $3, 'cancelled', NULL, 'NO_SHOW_EXPIRED', CURRENT_TIMESTAMP
           )`,
          [crypto.randomUUID(), booking.id, booking.status],
        );

        // 3. Upsert into booking_cancellations with 0% refund per existing no-show policy
        await client.query(
          `INSERT INTO booking_cancellations (
             id, booking_id, cancelled_by, cancellation_reason, cancelled_at,
             hours_before_start, refund_percentage, original_paid_amount,
             refund_amount, eligible_refund_amount, refund_status, upi_id,
             policy_name, created_at, updated_at
           ) VALUES (
             $1, $2, $3, 'NO_SHOW_EXPIRED', CURRENT_TIMESTAMP,
             0, 0, $4,
             0, 0, 'not_applicable', NULL,
             'NO_SHOW_EXPIRED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
           )
           ON CONFLICT (booking_id) DO UPDATE SET
             cancellation_reason = EXCLUDED.cancellation_reason,
             cancelled_at = EXCLUDED.cancelled_at,
             refund_percentage = 0,
             refund_amount = 0,
             eligible_refund_amount = 0,
             refund_status = 'not_applicable',
             policy_name = 'NO_SHOW_EXPIRED',
             updated_at = CURRENT_TIMESTAMP`,
          [cancellationId, booking.id, booking.customer_id, originalPaidAmount],
        );

        // 4. Ensure vehicle availability is restored to IDLE
        try {
          await client.query(
            `UPDATE vehicles
             SET rental_status = 'IDLE',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND rental_status != 'ACTIVE'`,
            [booking.vehicle_id],
          );
        } catch (_) {
          // vehicles table might lack rental_status column in legacy mock environments
        }

        // 5. Audit Log (source: SYSTEM/AUTO_EXPIRY)
        try {
          await client.query(
            `INSERT INTO audit_logs (
               id, actor_id, action, entity_type, entity_id, old_data, new_data, metadata, created_at
             ) VALUES (
               $1, NULL, 'BOOKING_AUTO_CANCELLED_NO_SHOW', 'booking', $2,
               $3, $4, $5, CURRENT_TIMESTAMP
             )`,
            [
              auditLogId,
              booking.id,
              JSON.stringify({ status: booking.status, booking_status: booking.booking_status }),
              JSON.stringify({ status: 'cancelled', booking_status: 'CANCELLED', reason: 'NO_SHOW_EXPIRED' }),
              JSON.stringify({
                source: 'SYSTEM/AUTO_EXPIRY',
                scheduledReturnAt: booking.expected_return_at || booking.end_at,
                reason: 'Customer no-show at scheduled return time without handover',
              }),
            ],
          );
        } catch (_) {
          // Non-fatal if audit_logs table schema differs
        }

        // 6. Partner Notification record (idempotent via unique constraint)
        if (booking.partner_id) {
          try {
            await client.query(
              `INSERT INTO partner_notifications (
                 id, partner_id, type, title, body, payload, event_key, created_at
               ) VALUES (
                 $1, $2, 'BOOKING_EXPIRED', 'Booking Expired (No-Show)',
                 $3, $4, $5, CURRENT_TIMESTAMP
               )
               ON CONFLICT (partner_id, event_key) DO NOTHING`,
              [
                partnerNotifId,
                booking.partner_id,
                `Booking ${displayRef} expired as the customer did not pick up the vehicle.`,
                JSON.stringify({
                  bookingId: booking.id,
                  bookingReference: displayRef,
                  reason: 'NO_SHOW_EXPIRED',
                }),
                eventKey,
              ],
            );
          } catch (pnErr) {
            this.logger.warn('Failed to insert partner no-show notification', {
              bookingId: booking.id,
              error: pnErr.message,
            });
          }
        }

        cancelledResults.push({
          id: booking.id,
          bookingReference: displayRef,
          customerId: booking.customer_id,
          partnerId: booking.partner_id,
          vehicleId: booking.vehicle_id,
          eventKey,
        });
      }

      await client.query('COMMIT');

      // Post-commit operations (Redis cache cleanup and push notifications)
      for (const item of cancelledResults) {
        // Invalidate handover OTP in Redis
        if (this.redisClient) {
          try {
            await this.redisClient.del(`otp:pickup:state:${item.id}`);
            await this.redisClient.del(`otp:pickup:attempts:${item.id}`);
          } catch (rErr) {
            this.logger.warn('Failed to clear OTP from Redis during auto-cancellation', {
              bookingId: item.id,
              error: rErr.message,
            });
          }
        }

        // Dispatch customer notification
        if (item.customerId) {
          try {
            await this.notificationService.sendNotification({
              customerId: item.customerId,
              type: NOTIFICATION_TYPES?.BOOKING_CANCELLED || 'BOOKING_CANCELLED',
              title: 'Booking Expired',
              body: `Your booking ${item.bookingReference} expired because the vehicle was not picked up before the scheduled return time.`,
              data: {
                bookingId: item.id,
                bookingReference: item.bookingReference,
                reason: 'NO_SHOW_EXPIRED',
                refundAmount: 0,
              },
              eventKey: item.eventKey,
            });
          } catch (notifErr) {
            this.logger.warn('Failed to send customer no-show notification', {
              bookingId: item.id,
              error: notifErr.message,
            });
          }
        }
      }

      if (cancelledResults.length > 0) {
        this.logger.info(`Auto-cancelled ${cancelledResults.length} expired no-show booking(s)`, {
          count: cancelledResults.length,
          bookingIds: cancelledResults.map((r) => r.id),
        });
      }

      return {
        processed: eligibleBookings.length,
        cancelled: cancelledResults,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      this.logger.error('Error during auto-cancellation of no-show bookings', {
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
    this.logger.info(`Starting No-Show Auto-Cancellation scheduler (interval: ${intervalMs}ms)`);

    const executeCycle = async () => {
      if (this.isProcessing || this.isShuttingDown) {
        return;
      }
      this.isProcessing = true;
      try {
        this.activeRunPromise = this.processExpiredBookings(50);
        await this.activeRunPromise;
      } catch (err) {
        this.logger.error('No-Show Auto-Cancellation cycle failed', { error: err.message });
      } finally {
        this.isProcessing = false;
        this.activeRunPromise = null;
      }
    };

    // Initial check shortly after startup
    setTimeout(() => {
      executeCycle().catch(() => {});
    }, 2000);

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
    this.logger.info('No-Show Auto-Cancellation scheduler stopped');
  }
}

const noShowAutoCancellationService = new NoShowAutoCancellationService();
noShowAutoCancellationService.NoShowAutoCancellationService = NoShowAutoCancellationService;

module.exports = noShowAutoCancellationService;
