'use strict';

/**
 * Migration: Create platform settings table for system configuration.
 *
 * Requirements:
 * - Domain categorization (general, booking, commission, notifications, security, system)
 * - Unique configuration key
 * - JSONB payload value for flexible typed configuration
 * - Audit reference to updating admin user
 * - Auto-updated timestamp via update_updated_at_column trigger
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS admin_settings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      category VARCHAR(50) NOT NULL,
      key VARCHAR(100) NOT NULL UNIQUE,
      value JSONB NOT NULL DEFAULT '{}'::jsonb,
      description TEXT,
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_admin_settings_category CHECK (
        category IN ('general', 'booking', 'commission', 'notifications', 'security', 'system')
      ),
      CONSTRAINT chk_admin_settings_key CHECK (key IS NOT NULL AND key != '')
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_admin_settings_category
    ON admin_settings (category);
  `);

  await pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_settings_key
    ON admin_settings (key);
  `);

  await pgm.sql(`
    CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = CURRENT_TIMESTAMP;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_admin_settings_updated_at ON admin_settings;
    CREATE TRIGGER trg_admin_settings_updated_at
    BEFORE UPDATE ON admin_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TRIGGER IF EXISTS trg_admin_settings_updated_at ON admin_settings;');
  await pgm.sql('DROP INDEX IF EXISTS idx_admin_settings_key;');
  await pgm.sql('DROP INDEX IF EXISTS idx_admin_settings_category;');
  await pgm.sql('DROP TABLE IF EXISTS admin_settings CASCADE;');
};
