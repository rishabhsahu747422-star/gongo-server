'use strict';

/**
 * Migration: Create coupons and coupon_redemptions tables.
 *
 * DESIGN DECISIONS:
 *   - `coupons`:
 *       - code: normalized uppercase string, UNIQUE.
 *       - discount_type: CHECK ('PERCENTAGE', 'FIXED').
 *       - discount_value: >= 0. If PERCENTAGE, must be between 0 and 100.
 *       - min_booking_amount: >= 0.
 *       - max_discount_amount: nullable or >= 0.
 *       - usage_limit: nullable or >= 0 (total redemptions allowed across platform).
 *       - per_customer_limit: >= 1 (max redemptions per customer).
 *       - valid_from <= valid_until.
 *   - `coupon_redemptions`:
 *       - Tracks individual redemptions by customer and booking.
 *       - Indexed for fast usage count aggregation and concurrency verification.
 */

exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS coupons (
      id                  UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
      code                VARCHAR(50)    NOT NULL,
      description         TEXT,
      discount_type       VARCHAR(20)    NOT NULL,
      discount_value      NUMERIC(12,2)  NOT NULL,
      min_booking_amount  NUMERIC(12,2)  NOT NULL DEFAULT 0.00,
      max_discount_amount NUMERIC(12,2),
      usage_limit         INTEGER,
      per_customer_limit  INTEGER        NOT NULL DEFAULT 1,
      valid_from          TIMESTAMPTZ    NOT NULL,
      valid_until         TIMESTAMPTZ    NOT NULL,
      is_active           BOOLEAN        NOT NULL DEFAULT true,
      created_at          TIMESTAMPTZ    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at          TIMESTAMPTZ    NOT NULL DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT chk_coupons_discount_type CHECK (
        discount_type IN ('PERCENTAGE', 'FIXED')
      ),
      CONSTRAINT chk_coupons_discount_value CHECK (discount_value >= 0),
      CONSTRAINT chk_coupons_percentage CHECK (
        discount_type != 'PERCENTAGE' OR (discount_value >= 0 AND discount_value <= 100)
      ),
      CONSTRAINT chk_coupons_min_amount CHECK (min_booking_amount >= 0),
      CONSTRAINT chk_coupons_max_discount CHECK (
        max_discount_amount IS NULL OR max_discount_amount >= 0
      ),
      CONSTRAINT chk_coupons_usage_limit CHECK (
        usage_limit IS NULL OR usage_limit >= 0
      ),
      CONSTRAINT chk_coupons_per_customer CHECK (per_customer_limit >= 1),
      CONSTRAINT chk_coupons_validity CHECK (valid_from <= valid_until)
    );
  `);

  // Case-insensitive unique constraint on coupon code
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_idx_coupons_code
    ON coupons (UPPER(code));
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_coupons_active_validity
    ON coupons (is_active, valid_from, valid_until);
  `);

  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_coupons_updated_at ON coupons;
    CREATE TRIGGER trg_coupons_updated_at
    BEFORE UPDATE ON coupons
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS coupon_redemptions (
      id              UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
      coupon_id       UUID           NOT NULL REFERENCES coupons(id) ON DELETE RESTRICT,
      customer_id     UUID           NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      booking_id      UUID           REFERENCES bookings(id) ON DELETE SET NULL,
      discount_amount NUMERIC(12,2)  NOT NULL,
      created_at      TIMESTAMPTZ    NOT NULL DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT chk_redemption_discount CHECK (discount_amount >= 0)
    );
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon_id
    ON coupon_redemptions (coupon_id);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_customer_id
    ON coupon_redemptions (customer_id);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon_customer
    ON coupon_redemptions (coupon_id, customer_id);
  `);
};

exports.down = async (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS coupon_redemptions CASCADE;');
  pgm.sql('DROP TRIGGER IF EXISTS trg_coupons_updated_at ON coupons;');
  pgm.sql('DROP TABLE IF EXISTS coupons CASCADE;');
};
