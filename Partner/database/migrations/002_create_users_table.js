'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      auth_id VARCHAR(128) NOT NULL,
      auth_provider VARCHAR(50) NOT NULL DEFAULT 'firebase',
      role VARCHAR(20) NOT NULL DEFAULT 'PARTNER',
      name VARCHAR(150),
      country_code VARCHAR(8) NOT NULL DEFAULT '+91',
      phone VARCHAR(20),
      email VARCHAR(255),
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_users_role CHECK (role IN ('PARTNER', 'CUSTOMER', 'ADMIN')),
      CONSTRAINT chk_users_contact_required CHECK (phone IS NOT NULL OR email IS NOT NULL)
    );
  `);

  await pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_auth_provider_auth_id
    ON users (auth_provider, auth_id);
  `);

  await pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_country_code_phone
    ON users (country_code, phone)
    WHERE phone IS NOT NULL;
  `);

  await pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower
    ON users (LOWER(email))
    WHERE email IS NOT NULL;
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_users_role
    ON users (role);
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
    CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TRIGGER IF EXISTS trg_users_updated_at ON users;');
  await pgm.sql('DROP TABLE IF EXISTS users CASCADE;');
};
