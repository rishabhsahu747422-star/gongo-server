'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS payouts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
      bank_account_id UUID NOT NULL REFERENCES partner_bank_accounts(id) ON DELETE RESTRICT,
      amount NUMERIC(12,2) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'REQUESTED',
      provider_transfer_id VARCHAR(100),
      failure_reason TEXT,
      idempotency_key VARCHAR(100),
      requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      processed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_payouts_amount CHECK (amount > 0.00),
      CONSTRAINT chk_payouts_status CHECK (status IN ('REQUESTED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'))
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_payouts_partner_id
    ON payouts (partner_id);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_payouts_status
    ON payouts (status);
  `);

  await pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_partner_idempotency
    ON payouts (partner_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_payouts_updated_at ON payouts;
    CREATE TRIGGER trg_payouts_updated_at
    BEFORE UPDATE ON payouts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TRIGGER IF EXISTS trg_payouts_updated_at ON payouts;');
  await pgm.sql('DROP TABLE IF EXISTS payouts CASCADE;');
};
