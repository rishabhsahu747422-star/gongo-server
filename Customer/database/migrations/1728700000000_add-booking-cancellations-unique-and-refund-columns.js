'use strict';

/**
 * Migration: Ensure booking_cancellations table has required refund metadata columns
 * and UNIQUE constraint on booking_id to support ON CONFLICT (booking_id) clauses.
 * Fully backward-compatible and idempotent.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    -- 1. Ensure required columns exist on booking_cancellations
    ALTER TABLE booking_cancellations
      ADD COLUMN IF NOT EXISTS hours_before_start NUMERIC(10,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS refund_percentage NUMERIC(5,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS original_paid_amount NUMERIC(10,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(10,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS eligible_refund_amount NUMERIC(10,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS refund_status VARCHAR(50) DEFAULT 'not_applicable',
      ADD COLUMN IF NOT EXISTS upi_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS policy_name VARCHAR(100),
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;

    -- 2. Ensure UNIQUE constraint exists on booking_id for ON CONFLICT (booking_id)
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'booking_cancellations'::regclass
          AND contype = 'u'
          AND conkey = ARRAY[(
            SELECT attnum FROM pg_attribute
            WHERE attrelid = 'booking_cancellations'::regclass
              AND attname = 'booking_id'
          )]
      ) THEN
        ALTER TABLE booking_cancellations ADD CONSTRAINT uq_booking_cancellations_booking_id UNIQUE (booking_id);
      END IF;
    EXCEPTION
      WHEN duplicate_table THEN
        NULL;
      WHEN others THEN
        NULL;
    END $$;

    -- 3. Ensure lookup index exists
    CREATE INDEX IF NOT EXISTS idx_booking_cancellations_booking_id
      ON booking_cancellations (booking_id);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql(`
    ALTER TABLE booking_cancellations
      DROP CONSTRAINT IF EXISTS uq_booking_cancellations_booking_id;

    DROP INDEX IF EXISTS idx_booking_cancellations_booking_id;

    ALTER TABLE booking_cancellations
      DROP COLUMN IF EXISTS hours_before_start,
      DROP COLUMN IF EXISTS refund_percentage,
      DROP COLUMN IF EXISTS eligible_refund_amount,
      DROP COLUMN IF EXISTS refund_status;
  `);
};
