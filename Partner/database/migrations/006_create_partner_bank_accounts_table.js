'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS partner_bank_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
      account_holder_name VARCHAR(150) NOT NULL,
      account_number_masked VARCHAR(30) NOT NULL,
      account_number_encrypted TEXT NOT NULL,
      ifsc_code VARCHAR(20) NOT NULL,
      bank_name VARCHAR(150) NOT NULL,
      is_primary BOOLEAN NOT NULL DEFAULT true,
      verification_status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_bank_verification_status CHECK (verification_status IN ('PENDING', 'VERIFIED', 'REJECTED'))
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_partner_bank_accounts_partner_id
    ON partner_bank_accounts (partner_id);
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_partner_bank_accounts_updated_at ON partner_bank_accounts;
    CREATE TRIGGER trg_partner_bank_accounts_updated_at
    BEFORE UPDATE ON partner_bank_accounts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TRIGGER IF EXISTS trg_partner_bank_accounts_updated_at ON partner_bank_accounts;');
  await pgm.sql('DROP TABLE IF EXISTS partner_bank_accounts CASCADE;');
};
