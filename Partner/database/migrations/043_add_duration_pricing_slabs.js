'use strict';

/**
 * Migration 043: Add duration-based pricing slabs (3 hours, 6 hours, 12 hours)
 * to vehicle_pricing and vehicle_pricing_history tables.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    -- Add columns to vehicle_pricing
    ALTER TABLE vehicle_pricing
    ADD COLUMN IF NOT EXISTS price_3_hours NUMERIC(12,2) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS price_6_hours NUMERIC(12,2) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS price_12_hours NUMERIC(12,2) DEFAULT NULL;

    -- Add check constraints to vehicle_pricing
    ALTER TABLE vehicle_pricing
    DROP CONSTRAINT IF EXISTS chk_vehicle_pricing_3_hours,
    DROP CONSTRAINT IF EXISTS chk_vehicle_pricing_6_hours,
    DROP CONSTRAINT IF EXISTS chk_vehicle_pricing_12_hours;

    ALTER TABLE vehicle_pricing
    ADD CONSTRAINT chk_vehicle_pricing_3_hours CHECK (price_3_hours IS NULL OR price_3_hours >= 0.00),
    ADD CONSTRAINT chk_vehicle_pricing_6_hours CHECK (price_6_hours IS NULL OR price_6_hours >= 0.00),
    ADD CONSTRAINT chk_vehicle_pricing_12_hours CHECK (price_12_hours IS NULL OR price_12_hours >= 0.00);

    -- Add columns to vehicle_pricing_history
    ALTER TABLE vehicle_pricing_history
    ADD COLUMN IF NOT EXISTS price_3_hours NUMERIC(12,2) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS price_6_hours NUMERIC(12,2) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS price_12_hours NUMERIC(12,2) DEFAULT NULL;

    -- Add check constraints to vehicle_pricing_history
    ALTER TABLE vehicle_pricing_history
    DROP CONSTRAINT IF EXISTS chk_pricing_hist_3_hours,
    DROP CONSTRAINT IF EXISTS chk_pricing_hist_6_hours,
    DROP CONSTRAINT IF EXISTS chk_pricing_hist_12_hours;

    ALTER TABLE vehicle_pricing_history
    ADD CONSTRAINT chk_pricing_hist_3_hours CHECK (price_3_hours IS NULL OR price_3_hours >= 0.00),
    ADD CONSTRAINT chk_pricing_hist_6_hours CHECK (price_6_hours IS NULL OR price_6_hours >= 0.00),
    ADD CONSTRAINT chk_pricing_hist_12_hours CHECK (price_12_hours IS NULL OR price_12_hours >= 0.00);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql(`
    ALTER TABLE vehicle_pricing
    DROP CONSTRAINT IF EXISTS chk_vehicle_pricing_3_hours,
    DROP CONSTRAINT IF EXISTS chk_vehicle_pricing_6_hours,
    DROP CONSTRAINT IF EXISTS chk_vehicle_pricing_12_hours,
    DROP COLUMN IF EXISTS price_3_hours,
    DROP COLUMN IF EXISTS price_6_hours,
    DROP COLUMN IF EXISTS price_12_hours;

    ALTER TABLE vehicle_pricing_history
    DROP CONSTRAINT IF EXISTS chk_pricing_hist_3_hours,
    DROP CONSTRAINT IF EXISTS chk_pricing_hist_6_hours,
    DROP CONSTRAINT IF EXISTS chk_pricing_hist_12_hours,
    DROP COLUMN IF EXISTS price_3_hours,
    DROP COLUMN IF EXISTS price_6_hours,
    DROP COLUMN IF EXISTS price_12_hours;
  `);
};
