'use strict';

/**
 * Migration: Add coupon snapshot columns to bookings table.
 *
 * Adds:
 *   - `coupon_id`: references coupons(id) ON DELETE SET NULL
 *   - `coupon_code`: VARCHAR(50)
 *   - `discount_amount`: NUMERIC(12,2) NOT NULL DEFAULT 0.00
 */

exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.sql(`
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS coupon_id UUID REFERENCES coupons(id) ON DELETE SET NULL;
  `);
  pgm.sql(`
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS coupon_code VARCHAR(50);
  `);
  pgm.sql(`
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00;
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_bookings_discount_amount'
      ) THEN
        ALTER TABLE bookings
        ADD CONSTRAINT chk_bookings_discount_amount CHECK (discount_amount >= 0);
      END IF;
    END $$;
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_bookings_coupon_id
    ON bookings (coupon_id);
  `);
};

exports.down = async (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS idx_bookings_coupon_id;');
  pgm.sql('ALTER TABLE bookings DROP CONSTRAINT IF EXISTS chk_bookings_discount_amount;');
  pgm.sql(`
    ALTER TABLE bookings
    DROP COLUMN IF EXISTS coupon_id,
    DROP COLUMN IF EXISTS coupon_code,
    DROP COLUMN IF EXISTS discount_amount;
  `);
};
