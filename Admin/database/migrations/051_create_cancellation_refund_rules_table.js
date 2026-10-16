'use strict';

/**
 * Migration: Create cancellation_refund_rules table for dynamic vehicle-specific cancellation policies.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS cancellation_refund_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      vehicle_type VARCHAR(20) NOT NULL CHECK (vehicle_type IN ('bike', 'car')),
      tier INTEGER NOT NULL CHECK (tier > 0),
      notice_hours NUMERIC(10, 2) NOT NULL CHECK (notice_hours > 0),
      refund_percentage NUMERIC(5, 2) NOT NULL CHECK (refund_percentage >= 0 AND refund_percentage <= 100),
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_cancellation_refund_rules_type_tier UNIQUE (vehicle_type, tier)
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_cancellation_refund_rules_lookup
    ON cancellation_refund_rules (vehicle_type, is_active, tier);
  `);

  await pgm.sql(`
    INSERT INTO cancellation_refund_rules (vehicle_type, tier, notice_hours, refund_percentage, is_active)
    VALUES
      ('bike', 1, 6, 0, true),
      ('bike', 2, 12, 50, true),
      ('bike', 3, 24, 100, true),
      ('car', 1, 12, 0, true),
      ('car', 2, 24, 50, true),
      ('car', 3, 24, 100, true)
    ON CONFLICT (vehicle_type, tier) DO NOTHING;
  `);
};

exports.down = async (pgm) => {
  await pgm.sql(`
    DROP TABLE IF EXISTS cancellation_refund_rules CASCADE;
  `);
};
