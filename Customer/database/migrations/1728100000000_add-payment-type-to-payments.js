'use strict';

/**
 * Migration: Add payment_type and index to payments table for post-rental settlement support.
 *
 * 1. Adds `payment_type` column ('BOOKING_ADVANCE' | 'POST_RENTAL_SETTLEMENT').
 * 2. Adds composite index on (booking_id, payment_type) for fast querying.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS payment_type VARCHAR(30) NOT NULL DEFAULT 'BOOKING_ADVANCE';
  `);

  await pgm.sql(`
    ALTER TABLE payments
    DROP CONSTRAINT IF EXISTS chk_payments_type;

    ALTER TABLE payments
    ADD CONSTRAINT chk_payments_type
    CHECK (payment_type IN ('BOOKING_ADVANCE', 'POST_RENTAL_SETTLEMENT'));
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_payments_booking_type
    ON payments (booking_id, payment_type);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP INDEX IF EXISTS idx_payments_booking_type;');
  await pgm.sql('ALTER TABLE payments DROP CONSTRAINT IF EXISTS chk_payments_type;');
  await pgm.sql('ALTER TABLE payments DROP COLUMN IF EXISTS payment_type;');
};
