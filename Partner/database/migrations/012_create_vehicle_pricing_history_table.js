'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS vehicle_pricing_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      price_per_hour NUMERIC(12,2) NOT NULL,
      price_per_4_hours NUMERIC(12,2) NOT NULL,
      price_per_day NUMERIC(12,2) NOT NULL,
      security_deposit NUMERIC(12,2) NOT NULL,
      extra_km_charge NUMERIC(12,2) NOT NULL,
      valid_from TIMESTAMPTZ NOT NULL,
      valid_to TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_pricing_hist_hourly CHECK (price_per_hour >= 0.00),
      CONSTRAINT chk_pricing_hist_4_hours CHECK (price_per_4_hours >= 0.00),
      CONSTRAINT chk_pricing_hist_daily CHECK (price_per_day >= 0.00),
      CONSTRAINT chk_pricing_hist_deposit CHECK (security_deposit >= 0.00),
      CONSTRAINT chk_pricing_hist_extra_km CHECK (extra_km_charge >= 0.00)
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicle_pricing_history_vehicle_id
    ON vehicle_pricing_history (vehicle_id);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicle_pricing_history_valid_range
    ON vehicle_pricing_history (vehicle_id, valid_from, valid_to);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TABLE IF EXISTS vehicle_pricing_history CASCADE;');
};
