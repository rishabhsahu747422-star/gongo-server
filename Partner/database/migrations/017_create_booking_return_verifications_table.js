'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS booking_return_verifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
      returned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      odometer_end NUMERIC(10,2),
      fuel_level_end VARCHAR(20),
      late_minutes INTEGER NOT NULL DEFAULT 0,
      late_fee NUMERIC(12,2) NOT NULL DEFAULT 0.00,
      extra_km NUMERIC(10,2) NOT NULL DEFAULT 0.00,
      extra_km_fee NUMERIC(12,2) NOT NULL DEFAULT 0.00,
      notes TEXT,
      photos TEXT[],
      verified_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_return_verifications_booking_id UNIQUE (booking_id),
      CONSTRAINT chk_return_odometer CHECK (odometer_end IS NULL OR odometer_end >= 0),
      CONSTRAINT chk_return_late_minutes CHECK (late_minutes >= 0),
      CONSTRAINT chk_return_late_fee CHECK (late_fee >= 0.00),
      CONSTRAINT chk_return_extra_km CHECK (extra_km >= 0.00),
      CONSTRAINT chk_return_extra_km_fee CHECK (extra_km_fee >= 0.00)
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_return_verifications_booking_id
    ON booking_return_verifications (booking_id);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TABLE IF EXISTS booking_return_verifications CASCADE;');
};
