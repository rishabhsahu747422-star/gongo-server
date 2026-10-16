'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS payments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
      customer_id UUID NOT NULL,
      provider VARCHAR(30) NOT NULL DEFAULT 'CASHFREE',
      provider_order_id VARCHAR(100) NOT NULL,
      provider_payment_id VARCHAR(100),
      amount NUMERIC(12,2) NOT NULL,
      currency VARCHAR(3) NOT NULL DEFAULT 'INR',
      status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
      idempotency_key VARCHAR(100),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_payments_provider_order_id UNIQUE (provider_order_id),
      CONSTRAINT chk_payments_provider CHECK (provider IN ('CASHFREE')),
      CONSTRAINT chk_payments_amount CHECK (amount > 0.00),
      CONSTRAINT chk_payments_status CHECK (status IN ('PENDING', 'USER_DROPPED', 'SUCCESS', 'FAILED', 'CANCELLED'))
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_payments_booking_id
    ON payments (booking_id);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_payments_customer_id
    ON payments (customer_id);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_payments_status
    ON payments (status);
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_payments_updated_at ON payments;
    CREATE TRIGGER trg_payments_updated_at
    BEFORE UPDATE ON payments
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TRIGGER IF EXISTS trg_payments_updated_at ON payments;');
  await pgm.sql('DROP TABLE IF EXISTS payments CASCADE;');
};
