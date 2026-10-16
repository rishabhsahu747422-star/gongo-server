'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS booking_pricing_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
      base_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
      rental_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
      security_deposit NUMERIC(12,2) NOT NULL DEFAULT 0.00,
      extra_km_charge NUMERIC(12,2) NOT NULL DEFAULT 0.00,
      late_fee NUMERIC(12,2) NOT NULL DEFAULT 0.00,
      discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
      taxes_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
      total_customer_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
      currency VARCHAR(3) NOT NULL DEFAULT 'INR',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_booking_pricing_snapshots_booking_id UNIQUE (booking_id),
      CONSTRAINT chk_pricing_snapshot_base CHECK (base_amount >= 0.00),
      CONSTRAINT chk_pricing_snapshot_rental CHECK (rental_amount >= 0.00),
      CONSTRAINT chk_pricing_snapshot_deposit CHECK (security_deposit >= 0.00),
      CONSTRAINT chk_pricing_snapshot_total CHECK (total_customer_amount >= 0.00)
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_booking_pricing_snapshots_booking_id
    ON booking_pricing_snapshots (booking_id);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TABLE IF EXISTS booking_pricing_snapshots CASCADE;');
};
