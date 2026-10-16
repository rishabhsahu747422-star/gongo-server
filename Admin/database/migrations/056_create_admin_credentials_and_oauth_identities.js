'use strict';

/**
 * Migration 056: Admin password credentials and linked OAuth identities.
 *
 * - admin_credentials: one scrypt password hash per administrator (users.id), plus
 *   brute-force lockout state. Kept out of the shared users table so Customer/Partner
 *   queries (some use SELECT *) can never read admin password hashes.
 * - admin_oauth_identities: explicit links between an administrator and an external
 *   identity (Google "sub"). Google sign-in only succeeds through a row here; accounts are
 *   never matched by email.
 *
 * Both tables get RLS enabled with no policies (deny-all through Supabase PostgREST);
 * the backend connects as the database owner and is unaffected. Additive only.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS admin_credentials (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      password_hash TEXT NOT NULL,
      must_change_password BOOLEAN NOT NULL DEFAULT false,
      password_updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      failed_login_count INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_admin_credentials_failed_count CHECK (failed_login_count >= 0)
    );
  `);

  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS admin_oauth_identities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(32) NOT NULL,
      provider_subject VARCHAR(255) NOT NULL,
      provider_email VARCHAR(255),
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_admin_oauth_identities_provider CHECK (provider IN ('google')),
      CONSTRAINT uq_admin_oauth_identities_subject UNIQUE (provider, provider_subject),
      CONSTRAINT uq_admin_oauth_identities_user_provider UNIQUE (user_id, provider)
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_admin_oauth_identities_user_id
    ON admin_oauth_identities (user_id);
  `);

  // Supports the case-insensitive admin email lookup used by password login.
  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_users_lower_email_admin_login
    ON users (LOWER(email));
  `);

  await pgm.sql(`
    ALTER TABLE admin_credentials ENABLE ROW LEVEL SECURITY;
    ALTER TABLE admin_oauth_identities ENABLE ROW LEVEL SECURITY;
  `);

  // Defense in depth on Supabase: strip API-role grants. Guarded so plain PostgreSQL
  // (no anon/authenticated roles) is unaffected.
  await pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE admin_credentials FROM anon;
        REVOKE ALL ON TABLE admin_oauth_identities FROM anon;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE admin_credentials FROM authenticated;
        REVOKE ALL ON TABLE admin_oauth_identities FROM authenticated;
      END IF;
    END
    $$ LANGUAGE plpgsql;
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_admin_credentials_updated_at ON admin_credentials;
    CREATE TRIGGER trg_admin_credentials_updated_at
    BEFORE UPDATE ON admin_credentials
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_admin_oauth_identities_updated_at ON admin_oauth_identities;
    CREATE TRIGGER trg_admin_oauth_identities_updated_at
    BEFORE UPDATE ON admin_oauth_identities
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TRIGGER IF EXISTS trg_admin_oauth_identities_updated_at ON admin_oauth_identities;');
  await pgm.sql('DROP TRIGGER IF EXISTS trg_admin_credentials_updated_at ON admin_credentials;');
  await pgm.sql('DROP INDEX IF EXISTS idx_users_lower_email_admin_login;');
  await pgm.sql('DROP INDEX IF EXISTS idx_admin_oauth_identities_user_id;');
  await pgm.sql('DROP TABLE IF EXISTS admin_oauth_identities;');
  await pgm.sql('DROP TABLE IF EXISTS admin_credentials;');
};
