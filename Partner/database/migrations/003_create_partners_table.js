'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS partners (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      partner_status VARCHAR(20) NOT NULL DEFAULT 'OFFLINE',
      kyc_status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
      profile_image_url TEXT,
      rating NUMERIC(3,2) NOT NULL DEFAULT 5.00,
      review_count INTEGER NOT NULL DEFAULT 0,
      registered_since VARCHAR(50),
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_partners_user_id UNIQUE (user_id),
      CONSTRAINT chk_partners_partner_status CHECK (partner_status IN ('ONLINE', 'OFFLINE')),
      CONSTRAINT chk_partners_kyc_status CHECK (kyc_status IN ('PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'SUSPENDED')),
      CONSTRAINT chk_partners_rating CHECK (rating >= 0.00 AND rating <= 5.00),
      CONSTRAINT chk_partners_review_count CHECK (review_count >= 0)
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_partners_user_id
    ON partners (user_id);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_partners_kyc_status
    ON partners (kyc_status);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_partners_partner_status
    ON partners (partner_status);
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_partners_updated_at ON partners;
    CREATE TRIGGER trg_partners_updated_at
    BEFORE UPDATE ON partners
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TRIGGER IF EXISTS trg_partners_updated_at ON partners;');
  await pgm.sql('DROP TABLE IF EXISTS partners CASCADE;');
};
