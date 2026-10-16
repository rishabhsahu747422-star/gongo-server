'use strict';

/**
 * Migration 034: Add Return Status, Total Distance & Pricing Snapshot Hardening.
 *
 * 1. Adds `price_per_hour` to `booking_pricing_snapshots` to preserve immutable historical rate for late calculations.
 * 2. Adds `return_status` ('ON_TIME' | 'LATE') to `booking_return_verifications`.
 * 3. Adds `total_distance` to `booking_return_verifications`.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  // 1. Add price_per_hour to booking_pricing_snapshots
  await pgm.sql(`
    ALTER TABLE booking_pricing_snapshots
    ADD COLUMN IF NOT EXISTS price_per_hour NUMERIC(12,2) NOT NULL DEFAULT 0.00;
  `);

  // 2. Add return_status and total_distance to booking_return_verifications
  await pgm.sql(`
    ALTER TABLE booking_return_verifications
    ADD COLUMN IF NOT EXISTS return_status VARCHAR(20) NOT NULL DEFAULT 'ON_TIME',
    ADD COLUMN IF NOT EXISTS total_distance NUMERIC(10,2) DEFAULT 0.00;
  `);

  // 3. Add constraint for return_status
  await pgm.sql(`
    ALTER TABLE booking_return_verifications
    DROP CONSTRAINT IF EXISTS chk_return_verifications_status;

    ALTER TABLE booking_return_verifications
    ADD CONSTRAINT chk_return_verifications_status
    CHECK (return_status IN ('ON_TIME', 'LATE'));
  `);

  // 4. Add constraint for total_distance
  await pgm.sql(`
    ALTER TABLE booking_return_verifications
    DROP CONSTRAINT IF EXISTS chk_return_total_distance;

    ALTER TABLE booking_return_verifications
    ADD CONSTRAINT chk_return_total_distance
    CHECK (total_distance IS NULL OR total_distance >= 0.00);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('ALTER TABLE booking_return_verifications DROP CONSTRAINT IF EXISTS chk_return_total_distance;');
  await pgm.sql('ALTER TABLE booking_return_verifications DROP CONSTRAINT IF EXISTS chk_return_verifications_status;');

  await pgm.sql(`
    ALTER TABLE booking_return_verifications
    DROP COLUMN IF EXISTS return_status,
    DROP COLUMN IF EXISTS total_distance;
  `);

  await pgm.sql(`
    ALTER TABLE booking_pricing_snapshots
    DROP COLUMN IF EXISTS price_per_hour;
  `);
};
