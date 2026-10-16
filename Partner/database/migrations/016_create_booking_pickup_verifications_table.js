'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS booking_pickup_verifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
      otp_hash VARCHAR(64),
      verification_reference VARCHAR(64),
      is_verified BOOLEAN NOT NULL DEFAULT true,
      verified_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      verified_by UUID,
      odometer_start NUMERIC(10,2),
      fuel_level_start VARCHAR(20),
      photos TEXT[],
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_pickup_verifications_booking_id UNIQUE (booking_id),
      CONSTRAINT chk_pickup_odometer CHECK (odometer_start IS NULL OR odometer_start >= 0)
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_pickup_verifications_booking_id
    ON booking_pickup_verifications (booking_id);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TABLE IF EXISTS booking_pickup_verifications CASCADE;');
};
