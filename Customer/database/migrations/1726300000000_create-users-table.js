'use strict';

/**
 * Migration: Create initial users table with roles, constraints, indexes, and triggers.
 *
 * Supported Roles:
 * - customer (default role for customer app)
 * - partner
 * - admin
 *
 * Security & Integrity:
 * - UUID v4 primary key via pgcrypto gen_random_uuid()
 * - Check constraint enforcing valid roles
 * - Check constraint requiring at least one contact method (phone OR email)
 * - Case-insensitive unique partial index on email
 * - Unique partial index on (country_code, phone)
 * - Unique partial index on (auth_provider, auth_id) for future Firebase/OAuth integration
 * - Automatic updated_at timestamp maintenance via trigger
 */

exports.shorthands = undefined;

exports.up = async (pgm) => {
  // 1. Enable pgcrypto for UUID generation
  pgm.sql('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');

  // 2. Create updated_at trigger function
  pgm.sql(`
    CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = CURRENT_TIMESTAMP;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  // 3. Create users table
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      role VARCHAR(20) NOT NULL DEFAULT 'customer',
      name VARCHAR(150),
      country_code VARCHAR(8) NOT NULL DEFAULT '+91',
      phone VARCHAR(20),
      email VARCHAR(255),
      auth_provider VARCHAR(50) DEFAULT 'firebase',
      auth_id VARCHAR(128),
      avatar_storage_key VARCHAR(512),
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_users_role CHECK (role IN ('customer', 'partner', 'admin')),
      CONSTRAINT chk_users_contact_required CHECK (phone IS NOT NULL OR email IS NOT NULL)
    );
  `);

  // 4. Create indexes
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_country_code_phone
    ON users (country_code, phone)
    WHERE phone IS NOT NULL;
  `);

  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower
    ON users (LOWER(email))
    WHERE email IS NOT NULL;
  `);

  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_auth_provider_auth_id
    ON users (auth_provider, auth_id)
    WHERE auth_id IS NOT NULL;
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_users_role
    ON users (role);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_users_is_active
    ON users (is_active);
  `);

  // 5. Attach updated_at trigger
  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
    CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  pgm.sql('DROP TRIGGER IF EXISTS trg_users_updated_at ON users;');
  pgm.sql('DROP TABLE IF EXISTS users CASCADE;');
  pgm.sql('DROP FUNCTION IF EXISTS update_updated_at_column();');
};
