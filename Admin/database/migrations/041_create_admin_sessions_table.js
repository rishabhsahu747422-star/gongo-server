'use strict';

/**
 * Migration: Create administrative session state tracking table.
 *
 * Requirements:
 * - Foreign key referencing canonical users(id) table with CASCADE deletion
 * - Unique session token
 * - Expiration and active state tracking for revocation
 * - IP and user agent tracking
 * - Last active timestamp and updated_at trigger
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_token VARCHAR(255) NOT NULL UNIQUE,
      ip_address VARCHAR(45),
      user_agent TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      expires_at TIMESTAMPTZ NOT NULL,
      last_active_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_user_id
    ON admin_sessions (user_id);
  `);

  await pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_sessions_token
    ON admin_sessions (session_token);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_active_expiry
    ON admin_sessions (is_active, expires_at);
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_admin_sessions_updated_at ON admin_sessions;
    CREATE TRIGGER trg_admin_sessions_updated_at
    BEFORE UPDATE ON admin_sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TRIGGER IF EXISTS trg_admin_sessions_updated_at ON admin_sessions;');
  await pgm.sql('DROP INDEX IF EXISTS idx_admin_sessions_active_expiry;');
  await pgm.sql('DROP INDEX IF EXISTS idx_admin_sessions_token;');
  await pgm.sql('DROP INDEX IF EXISTS idx_admin_sessions_user_id;');
  await pgm.sql('DROP TABLE IF EXISTS admin_sessions CASCADE;');
};
