'use strict';

/**
 * Migration 035: Add payment_type and metadata to payments table.
 *
 * 1. Adds `payment_type` to distinguish between initial advance booking payments
 *    and post-rental return charge settlements.
 * 2. Adds `metadata` JSONB column for gateway order information and charge breakdowns.
 * 3. Adds index on (booking_id, payment_type) for fast partner query filtering.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS payment_type VARCHAR(30) NOT NULL DEFAULT 'BOOKING_ADVANCE',
    ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
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
  await pgm.sql(`
    ALTER TABLE payments
    DROP COLUMN IF EXISTS metadata,
    DROP COLUMN IF EXISTS payment_type;
  `);
};
