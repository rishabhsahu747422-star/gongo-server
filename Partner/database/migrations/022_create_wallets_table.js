'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS wallets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
      available_balance NUMERIC(12,2) NOT NULL DEFAULT 0.00,
      pending_balance NUMERIC(12,2) NOT NULL DEFAULT 0.00,
      total_credited NUMERIC(12,2) NOT NULL DEFAULT 0.00,
      total_debited NUMERIC(12,2) NOT NULL DEFAULT 0.00,
      currency VARCHAR(3) NOT NULL DEFAULT 'INR',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_wallets_partner_id UNIQUE (partner_id),
      CONSTRAINT chk_wallets_available_balance CHECK (available_balance >= 0.00),
      CONSTRAINT chk_wallets_pending_balance CHECK (pending_balance >= 0.00),
      CONSTRAINT chk_wallets_total_credited CHECK (total_credited >= 0.00),
      CONSTRAINT chk_wallets_total_debited CHECK (total_debited >= 0.00)
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_wallets_partner_id
    ON wallets (partner_id);
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_wallets_updated_at ON wallets;
    CREATE TRIGGER trg_wallets_updated_at
    BEFORE UPDATE ON wallets
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TRIGGER IF EXISTS trg_wallets_updated_at ON wallets;');
  await pgm.sql('DROP TABLE IF EXISTS wallets CASCADE;');
};
