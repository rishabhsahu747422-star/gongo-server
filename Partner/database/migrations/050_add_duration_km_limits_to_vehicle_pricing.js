'use strict';

/**
 * Migration 050: Add duration-based KM limits (1 hour, 3 hours, 6 hours, 12 hours, 1 day)
 * to vehicle_pricing and vehicle_pricing_history tables.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    -- Add KM limit columns to vehicle_pricing
    ALTER TABLE vehicle_pricing
    ADD COLUMN IF NOT EXISTS km_limit_per_day NUMERIC(10,2) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS km_limit_per_hour NUMERIC(10,2) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS km_limit_3_hours NUMERIC(10,2) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS km_limit_6_hours NUMERIC(10,2) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS km_limit_12_hours NUMERIC(10,2) DEFAULT NULL;

    -- Add check constraints to vehicle_pricing
    ALTER TABLE vehicle_pricing
    DROP CONSTRAINT IF EXISTS chk_vehicle_pricing_km_day,
    DROP CONSTRAINT IF EXISTS chk_vehicle_pricing_km_hour,
    DROP CONSTRAINT IF EXISTS chk_vehicle_pricing_km_3_hours,
    DROP CONSTRAINT IF EXISTS chk_vehicle_pricing_km_6_hours,
    DROP CONSTRAINT IF EXISTS chk_vehicle_pricing_km_12_hours;

    ALTER TABLE vehicle_pricing
    ADD CONSTRAINT chk_vehicle_pricing_km_day CHECK (km_limit_per_day IS NULL OR km_limit_per_day >= 0.00),
    ADD CONSTRAINT chk_vehicle_pricing_km_hour CHECK (km_limit_per_hour IS NULL OR km_limit_per_hour >= 0.00),
    ADD CONSTRAINT chk_vehicle_pricing_km_3_hours CHECK (km_limit_3_hours IS NULL OR km_limit_3_hours >= 0.00),
    ADD CONSTRAINT chk_vehicle_pricing_km_6_hours CHECK (km_limit_6_hours IS NULL OR km_limit_6_hours >= 0.00),
    ADD CONSTRAINT chk_vehicle_pricing_km_12_hours CHECK (km_limit_12_hours IS NULL OR km_limit_12_hours >= 0.00);

    -- Add KM limit columns to vehicle_pricing_history
    ALTER TABLE vehicle_pricing_history
    ADD COLUMN IF NOT EXISTS km_limit_per_day NUMERIC(10,2) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS km_limit_per_hour NUMERIC(10,2) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS km_limit_3_hours NUMERIC(10,2) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS km_limit_6_hours NUMERIC(10,2) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS km_limit_12_hours NUMERIC(10,2) DEFAULT NULL;

    -- Add check constraints to vehicle_pricing_history
    ALTER TABLE vehicle_pricing_history
    DROP CONSTRAINT IF EXISTS chk_pricing_hist_km_day,
    DROP CONSTRAINT IF EXISTS chk_pricing_hist_km_hour,
    DROP CONSTRAINT IF EXISTS chk_pricing_hist_km_3_hours,
    DROP CONSTRAINT IF EXISTS chk_pricing_hist_km_6_hours,
    DROP CONSTRAINT IF EXISTS chk_pricing_hist_km_12_hours;

    ALTER TABLE vehicle_pricing_history
    ADD CONSTRAINT chk_pricing_hist_km_day CHECK (km_limit_per_day IS NULL OR km_limit_per_day >= 0.00),
    ADD CONSTRAINT chk_pricing_hist_km_hour CHECK (km_limit_per_hour IS NULL OR km_limit_per_hour >= 0.00),
    ADD CONSTRAINT chk_pricing_hist_km_3_hours CHECK (km_limit_3_hours IS NULL OR km_limit_3_hours >= 0.00),
    ADD CONSTRAINT chk_pricing_hist_km_6_hours CHECK (km_limit_6_hours IS NULL OR km_limit_6_hours >= 0.00),
    ADD CONSTRAINT chk_pricing_hist_km_12_hours CHECK (km_limit_12_hours IS NULL OR km_limit_12_hours >= 0.00);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql(`
    ALTER TABLE vehicle_pricing
    DROP CONSTRAINT IF EXISTS chk_vehicle_pricing_km_day,
    DROP CONSTRAINT IF EXISTS chk_vehicle_pricing_km_hour,
    DROP CONSTRAINT IF EXISTS chk_vehicle_pricing_km_3_hours,
    DROP CONSTRAINT IF EXISTS chk_vehicle_pricing_km_6_hours,
    DROP CONSTRAINT IF EXISTS chk_vehicle_pricing_km_12_hours,
    DROP COLUMN IF EXISTS km_limit_per_day,
    DROP COLUMN IF EXISTS km_limit_per_hour,
    DROP COLUMN IF EXISTS km_limit_3_hours,
    DROP COLUMN IF EXISTS km_limit_6_hours,
    DROP COLUMN IF EXISTS km_limit_12_hours;

    ALTER TABLE vehicle_pricing_history
    DROP CONSTRAINT IF EXISTS chk_pricing_hist_km_day,
    DROP CONSTRAINT IF EXISTS chk_pricing_hist_km_hour,
    DROP CONSTRAINT IF EXISTS chk_pricing_hist_km_3_hours,
    DROP CONSTRAINT IF EXISTS chk_pricing_hist_km_6_hours,
    DROP CONSTRAINT IF EXISTS chk_pricing_hist_km_12_hours,
    DROP COLUMN IF EXISTS km_limit_per_day,
    DROP COLUMN IF EXISTS km_limit_per_hour,
    DROP COLUMN IF EXISTS km_limit_3_hours,
    DROP COLUMN IF EXISTS km_limit_6_hours,
    DROP COLUMN IF EXISTS km_limit_12_hours;
  `);
};
