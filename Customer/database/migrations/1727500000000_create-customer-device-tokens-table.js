'use strict';

/**
 * Migration: Create customer_device_tokens table for push notifications (FCM).
 *
 * DESIGN DECISIONS:
 *   - `customer_id` references users(id) ON DELETE CASCADE.
 *   - `device_token` is unique: a single physical device token belongs to one active session.
 *   - `platform`: restricted to 'ANDROID' and 'IOS'.
 *   - `is_active`: soft deactivation when tokens expire or device is logged out.
 *   - Indexes: customer_id, active tokens lookup, token uniqueness.
 */

exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS customer_device_tokens (
      id            UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id   UUID           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_token  VARCHAR(500)   NOT NULL UNIQUE,
      platform      VARCHAR(20)    NOT NULL,
      app_version   VARCHAR(50),
      device_id     VARCHAR(255),
      is_active     BOOLEAN        NOT NULL DEFAULT true,
      last_seen_at  TIMESTAMPTZ    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at    TIMESTAMPTZ    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    TIMESTAMPTZ    NOT NULL DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT chk_device_tokens_platform CHECK (platform IN ('ANDROID', 'IOS'))
    );
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_customer_device_tokens_customer_id
    ON customer_device_tokens (customer_id);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_customer_device_tokens_active
    ON customer_device_tokens (customer_id, is_active);
  `);

  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_customer_device_tokens_updated_at ON customer_device_tokens;
    CREATE TRIGGER trg_customer_device_tokens_updated_at
    BEFORE UPDATE ON customer_device_tokens
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  pgm.sql('DROP TRIGGER IF EXISTS trg_customer_device_tokens_updated_at ON customer_device_tokens;');
  pgm.sql('DROP TABLE IF EXISTS customer_device_tokens CASCADE;');
};
