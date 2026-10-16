'use strict';

/**
 * Migration: Create idempotency_keys table.
 *
 * Used to provide robust idempotency for POST /api/v1/bookings requests:
 *   - Same idempotency key + user_id + request_hash returns the recorded response.
 *   - Same key + different request_hash raises an idempotency conflict.
 *   - Automatic expiration via expires_at.
 */

exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      key             VARCHAR(255) NOT NULL,
      user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_path    VARCHAR(255) NOT NULL,
      request_hash    VARCHAR(64)  NOT NULL,
      response_status INTEGER      NOT NULL,
      response_body   JSONB        NOT NULL,
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at      TIMESTAMPTZ  NOT NULL,
      CONSTRAINT uq_idempotency_user_key UNIQUE (user_id, key)
    );
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_idempotency_user_key
    ON idempotency_keys (user_id, key);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_idempotency_expires_at
    ON idempotency_keys (expires_at);
  `);
};

exports.down = async (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS idempotency_keys CASCADE;');
};
