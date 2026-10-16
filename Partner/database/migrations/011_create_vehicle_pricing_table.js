'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS vehicle_pricing (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      price_per_hour NUMERIC(12,2) NOT NULL DEFAULT 0.00,
      price_per_4_hours NUMERIC(12,2) NOT NULL DEFAULT 0.00,
      price_per_day NUMERIC(12,2) NOT NULL DEFAULT 0.00,
      security_deposit NUMERIC(12,2) NOT NULL DEFAULT 0.00,
      extra_km_charge NUMERIC(12,2) NOT NULL DEFAULT 0.00,
      currency VARCHAR(3) NOT NULL DEFAULT 'INR',
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_vehicle_pricing_vehicle_id UNIQUE (vehicle_id),
      CONSTRAINT chk_vehicle_pricing_hourly CHECK (price_per_hour >= 0.00),
      CONSTRAINT chk_vehicle_pricing_4_hours CHECK (price_per_4_hours >= 0.00),
      CONSTRAINT chk_vehicle_pricing_daily CHECK (price_per_day >= 0.00),
      CONSTRAINT chk_vehicle_pricing_deposit CHECK (security_deposit >= 0.00),
      CONSTRAINT chk_vehicle_pricing_extra_km CHECK (extra_km_charge >= 0.00)
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicle_pricing_vehicle_id
    ON vehicle_pricing (vehicle_id);
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_vehicle_pricing_updated_at ON vehicle_pricing;
    CREATE TRIGGER trg_vehicle_pricing_updated_at
    BEFORE UPDATE ON vehicle_pricing
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TRIGGER IF EXISTS trg_vehicle_pricing_updated_at ON vehicle_pricing;');
  await pgm.sql('DROP TABLE IF EXISTS vehicle_pricing CASCADE;');
};
