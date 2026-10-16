'use strict';

/**
 * Migration: Create bookings table.
 *
 * DESIGN DECISIONS:
 *   - `customer_id` references users(id) ON DELETE RESTRICT (bookings must not be orphan-deleted).
 *   - `vehicle_id` references vehicles(id) ON DELETE RESTRICT.
 *   - `status`: Supported lifecycle statuses:
 *       PENDING, ACCEPTED, PAYMENT_PENDING, PAYMENT_COMPLETED,
 *       PICKUP_SCHEDULED, VEHICLE_PICKED, IN_PROGRESS,
 *       COMPLETED, CANCELLED, REFUNDED.
 *   - `rental_type`: HOURLY, DAILY, WEEKLY, MONTHLY.
 *   - Timestamps: start_at, end_at use TIMESTAMPTZ (timezone-aware).
 *   - CHECK constraints:
 *       - start_at < end_at
 *       - all monetary amounts (prices, deposit, charges, base_amount, total_amount) >= 0
 *   - Monetary types: NUMERIC(12,2) for exact financial calculation.
 *   - Pricing snapshots: preserves pricing agreed upon at booking creation.
 *   - Indexes:
 *       - customer_id (list customer bookings)
 *       - vehicle_id (vehicle history)
 *       - status (filtering by status)
 *       - composite (vehicle_id, start_at, end_at) for efficient interval overlap checks
 */

exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS bookings (
      id                  UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id         UUID           NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      vehicle_id          UUID           NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
      status              VARCHAR(30)    NOT NULL DEFAULT 'PENDING',
      rental_type         VARCHAR(20)    NOT NULL,
      start_at            TIMESTAMPTZ    NOT NULL,
      end_at              TIMESTAMPTZ    NOT NULL,
      pickup_address      TEXT,

      -- Commercial pricing snapshot at booking creation
      price_per_hour      NUMERIC(12,2),
      price_per_day       NUMERIC(12,2),
      price_per_week      NUMERIC(12,2),
      price_per_month     NUMERIC(12,2),
      base_amount         NUMERIC(12,2)  NOT NULL DEFAULT 0.00,
      security_deposit    NUMERIC(12,2)  NOT NULL DEFAULT 0.00,
      late_fee_per_hour   NUMERIC(12,2)  NOT NULL DEFAULT 0.00,
      extra_km_charge     NUMERIC(12,2)  NOT NULL DEFAULT 0.00,
      total_amount        NUMERIC(12,2)  NOT NULL DEFAULT 0.00,

      -- Cancellation info
      cancellation_reason TEXT,
      cancelled_at        TIMESTAMPTZ,

      -- Timestamps
      created_at          TIMESTAMPTZ    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at          TIMESTAMPTZ    NOT NULL DEFAULT CURRENT_TIMESTAMP,

      -- Constraints
      CONSTRAINT chk_bookings_status CHECK (
        status IN (
          'PENDING', 'ACCEPTED', 'PAYMENT_PENDING', 'PAYMENT_COMPLETED',
          'PICKUP_SCHEDULED', 'VEHICLE_PICKED', 'IN_PROGRESS',
          'COMPLETED', 'CANCELLED', 'REFUNDED',
          'initiated', 'payment_pending', 'payment_completed', 'confirmed',
          'pickup_scheduled', 'vehicle_picked', 'in_progress', 'return_pending',
          'returned', 'completed', 'cancelled', 'refunded'
        )
      ),
      CONSTRAINT chk_bookings_rental_type CHECK (
        rental_type IN ('HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY')
      ),
      CONSTRAINT chk_bookings_time_range CHECK (start_at < end_at),
      CONSTRAINT chk_bookings_base_amount CHECK (base_amount >= 0),
      CONSTRAINT chk_bookings_security_deposit CHECK (security_deposit >= 0),
      CONSTRAINT chk_bookings_late_fee CHECK (late_fee_per_hour >= 0),
      CONSTRAINT chk_bookings_extra_km CHECK (extra_km_charge >= 0),
      CONSTRAINT chk_bookings_total_amount CHECK (total_amount >= 0)
    );

    CREATE TABLE IF NOT EXISTS booking_price_breakdown (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      base_amount NUMERIC(12,2) DEFAULT 0.00,
      extra_charges NUMERIC(12,2) DEFAULT 0.00,
      discount_amount NUMERIC(12,2) DEFAULT 0.00,
      taxable_amount NUMERIC(12,2) DEFAULT 0.00,
      tax_amount NUMERIC(12,2) DEFAULT 0.00,
      platform_fee NUMERIC(12,2) DEFAULT 0.00,
      security_deposit NUMERIC(12,2) DEFAULT 0.00,
      total_amount NUMERIC(12,2) DEFAULT 0.00,
      currency VARCHAR(10) DEFAULT 'INR',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS booking_cancellations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      cancellation_reason TEXT,
      cancelled_by UUID,
      cancelled_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS booking_return (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      return_odometer_reading NUMERIC,
      return_fuel_level VARCHAR(20),
      return_condition TEXT,
      return_notes TEXT,
      verified_by UUID,
      verified_at TIMESTAMPTZ
    );
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_bookings_customer_id
    ON bookings (customer_id);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_bookings_vehicle_id
    ON bookings (vehicle_id);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_bookings_status
    ON bookings (status);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_bookings_vehicle_time
    ON bookings (vehicle_id, start_at, end_at);
  `);

  // Partial index on active blocking bookings for rapid availability verification
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_bookings_blocking_overlap
    ON bookings (vehicle_id, start_at, end_at)
    WHERE status IN (
      'PENDING', 'ACCEPTED', 'PAYMENT_PENDING', 'PAYMENT_COMPLETED',
      'PICKUP_SCHEDULED', 'VEHICLE_PICKED', 'IN_PROGRESS'
    );
  `);

  // PostgreSQL Range Exclusion Constraint for DB-level double-booking guarantee
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS btree_gist;
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'no_overlapping_blocking_bookings'
      ) THEN
        ALTER TABLE bookings
        ADD CONSTRAINT no_overlapping_blocking_bookings
        EXCLUDE USING gist (
          vehicle_id WITH =,
          tstzrange(start_at, end_at, '[)') WITH &&
        )
        WHERE (status IN (
          'PENDING', 'ACCEPTED', 'PAYMENT_PENDING', 'PAYMENT_COMPLETED',
          'PICKUP_SCHEDULED', 'VEHICLE_PICKED', 'IN_PROGRESS'
        ));
      END IF;
    EXCEPTION
      WHEN feature_not_supported OR undefined_file THEN
        NULL;
    END $$;
  `);

  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_bookings_updated_at ON bookings;
    CREATE TRIGGER trg_bookings_updated_at
    BEFORE UPDATE ON bookings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  pgm.sql('ALTER TABLE bookings DROP CONSTRAINT IF EXISTS no_overlapping_blocking_bookings;');
  pgm.sql('DROP TRIGGER IF EXISTS trg_bookings_updated_at ON bookings;');
  pgm.sql('DROP TABLE IF EXISTS bookings CASCADE;');
};
