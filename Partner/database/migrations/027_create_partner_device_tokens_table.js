'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS partner_device_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      token VARCHAR(500) NOT NULL,
      platform VARCHAR(20) NOT NULL DEFAULT 'android',
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_partner_device_tokens UNIQUE (partner_id, token),
      CONSTRAINT chk_device_tokens_platform CHECK (platform IN ('android', 'ios', 'web'))
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_partner_device_tokens_partner_id
    ON partner_device_tokens (partner_id);
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_partner_device_tokens_updated_at ON partner_device_tokens;
    CREATE TRIGGER trg_partner_device_tokens_updated_at
    BEFORE UPDATE ON partner_device_tokens
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TRIGGER IF EXISTS trg_partner_device_tokens_updated_at ON partner_device_tokens;');
  await pgm.sql('DROP TABLE IF EXISTS partner_device_tokens CASCADE;');
};
