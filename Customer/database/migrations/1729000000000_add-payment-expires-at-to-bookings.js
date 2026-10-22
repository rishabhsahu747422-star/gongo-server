'use strict';

/**
 * Migration: Add payment_expires_at to bookings table for 5-minute payment countdown & auto-cancellation.
 *
 * DESIGN DECISIONS:
 *   - `payment_expires_at`: TIMESTAMPTZ column storing the authoritative server-side deadline.
 *   - Safe backfill: For existing pending bookings, set payment_expires_at = COALESCE(payment.created_at, bookings.created_at) + interval '5 minutes'.
 *   - Partial index on payment_expires_at for active pending bookings to ensure fast, low-load scheduler scans.
 */

exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.sql(`
    ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS payment_expires_at TIMESTAMPTZ;

    -- Backfill existing pending bookings
    UPDATE bookings
    SET payment_expires_at = COALESCE(
      (
        SELECT p.created_at
        FROM payments p
        WHERE p.booking_id = bookings.id
          AND (p.payment_type = 'BOOKING_ADVANCE' OR p.payment_type IS NULL)
        ORDER BY p.created_at DESC
        LIMIT 1
      ),
      bookings.created_at
    ) + interval '5 minutes'
    WHERE payment_expires_at IS NULL
      AND status IN ('PENDING', 'payment_pending', 'initiated', 'PAYMENT_PENDING');

    -- Index for high-performance timeout scheduler scans
    CREATE INDEX IF NOT EXISTS idx_bookings_payment_expires_at
    ON bookings (payment_expires_at)
    WHERE status IN ('payment_pending', 'initiated', 'PAYMENT_PENDING', 'PENDING');
  `);
};

exports.down = async (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_bookings_payment_expires_at;
    ALTER TABLE bookings DROP COLUMN IF EXISTS payment_expires_at;
  `);
};
