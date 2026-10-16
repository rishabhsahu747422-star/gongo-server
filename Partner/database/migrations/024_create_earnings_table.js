'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS earnings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
      wallet_transaction_id UUID REFERENCES wallet_transactions(id) ON DELETE RESTRICT,
      gross_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
      partner_net_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
      settlement_status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
      settled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_earnings_booking_id UNIQUE (booking_id),
      CONSTRAINT chk_earnings_gross_amount CHECK (gross_amount >= 0.00),
      CONSTRAINT chk_earnings_net_amount CHECK (partner_net_amount >= 0.00),
      CONSTRAINT chk_earnings_settlement_status CHECK (settlement_status IN ('PENDING', 'SETTLED', 'ON_HOLD', 'CANCELLED'))
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_earnings_partner_id
    ON earnings (partner_id);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_earnings_settlement_status
    ON earnings (settlement_status);
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_earnings_updated_at ON earnings;
    CREATE TRIGGER trg_earnings_updated_at
    BEFORE UPDATE ON earnings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TRIGGER IF EXISTS trg_earnings_updated_at ON earnings;');
  await pgm.sql('DROP TABLE IF EXISTS earnings CASCADE;');
};
