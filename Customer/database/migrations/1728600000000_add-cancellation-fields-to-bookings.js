'use strict';

/**
 * Migration: Add cancellation_reason and cancelled_at columns to bookings table
 * to ensure schema parity across Customer, Partner, and Admin services.
 * Backward-compatible: uses IF NOT EXISTS and IF EXISTS guards.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    ALTER TABLE bookings 
      ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
      ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_bookings_cancelled_at 
      ON bookings (cancelled_at) 
      WHERE cancelled_at IS NOT NULL;
  `);
};

exports.down = async (pgm) => {
  await pgm.sql(`
    DROP INDEX IF EXISTS idx_bookings_cancelled_at;

    ALTER TABLE bookings 
      DROP COLUMN IF EXISTS cancellation_reason,
      DROP COLUMN IF EXISTS cancelled_at;
  `);
};
