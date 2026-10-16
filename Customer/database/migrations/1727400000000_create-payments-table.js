'use strict';

/**
 * Migration: Create payments table for payment lifecycle tracking.
 *
 * DESIGN DECISIONS:
 *   - `booking_id`: References bookings(id) ON DELETE RESTRICT (audit ledger).
 *   - `customer_id`: References users(id) ON DELETE RESTRICT.
 *   - `provider`: Default 'CASHFREE'.
 *   - `provider_order_id`: Unique identifier assigned by/for payment provider.
 *   - `provider_payment_id`: Specific transaction/payment ID from provider.
 *   - `amount`: NUMERIC(12,2) with non-negative check constraint.
 *   - `status`: State machine with check constraint:
 *       'CREATED', 'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED'.
 *   - Indexes on booking_id, customer_id, provider_order_id, and status.
 */

exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS payments (
      id                  UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id          UUID           NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
      customer_id         UUID           NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      provider            VARCHAR(30)    NOT NULL DEFAULT 'CASHFREE',
      provider_order_id   VARCHAR(100)   NOT NULL,
      provider_payment_id VARCHAR(100),
      payment_number      VARCHAR(50),
      amount              NUMERIC(12,2)  NOT NULL,
      currency            VARCHAR(10)    NOT NULL DEFAULT 'INR',
      status              VARCHAR(30)    NOT NULL DEFAULT 'initiated',
      payment_method      VARCHAR(50),
      failure_reason      TEXT,
      metadata            JSONB,
      paid_at             TIMESTAMPTZ,
      payment_type        VARCHAR(30)    NOT NULL DEFAULT 'BOOKING_ADVANCE',
      created_at          TIMESTAMPTZ    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at          TIMESTAMPTZ    NOT NULL DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT uq_payments_provider_order_id UNIQUE (provider_order_id),
      CONSTRAINT chk_payments_amount CHECK (amount >= 0),
      CONSTRAINT chk_payments_status CHECK (
        status IN (
          'CREATED', 'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED',
          'initiated', 'pending', 'authorized', 'paid', 'failed', 'cancelled', 'refunded', 'partially_refunded'
        )
      ),
      CONSTRAINT chk_payments_type CHECK (
        payment_type IN ('BOOKING_ADVANCE', 'POST_RENTAL_SETTLEMENT', 'RENTAL')
      )
    );

    CREATE TABLE IF NOT EXISTS payment_attempts (
      id                  UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
      payment_id          UUID           NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
      attempt_number      INT            NOT NULL DEFAULT 1,
      gateway             VARCHAR(50)    NOT NULL,
      gateway_order_id    VARCHAR(100),
      gateway_payment_id  VARCHAR(100),
      amount              NUMERIC(12,2)  NOT NULL,
      currency            VARCHAR(10)    NOT NULL DEFAULT 'INR',
      status              VARCHAR(30)    NOT NULL DEFAULT 'pending',
      failure_reason      TEXT,
      completed_at        TIMESTAMPTZ,
      created_at          TIMESTAMPTZ    NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_payments_booking_id
    ON payments (booking_id);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_payments_customer_id
    ON payments (customer_id);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_payments_status
    ON payments (status);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_payments_provider_order_id
    ON payments (provider_order_id);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_payments_booking_type
    ON payments (booking_id, payment_type);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_payments_active_booking
    ON payments (booking_id)
    WHERE status IN ('CREATED', 'PENDING', 'SUCCESS', 'initiated', 'pending', 'paid');
  `);

  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_payments_updated_at ON payments;
    CREATE TRIGGER trg_payments_updated_at
    BEFORE UPDATE ON payments
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  pgm.sql('DROP TRIGGER IF EXISTS trg_payments_updated_at ON payments;');
  pgm.sql('DROP TABLE IF EXISTS payments CASCADE;');
};
