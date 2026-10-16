'use strict';

/**
 * Migration: Create persistent audit logs.
 *
 * SECURITY:
 *   Audit logs are strictly append-only.
 *   Sensitive credentials, passwords, tokens, and bank details must be sanitized
 *   before insertion by the application audit service.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_id VARCHAR(128) NOT NULL,
      actor_role VARCHAR(50) NOT NULL DEFAULT 'PARTNER',
      action VARCHAR(100) NOT NULL,
      entity_type VARCHAR(100) NOT NULL,
      entity_id VARCHAR(128) NOT NULL,
      request_id VARCHAR(128),
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_id
    ON audit_logs (actor_id);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_audit_logs_entity
    ON audit_logs (entity_type, entity_id);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
    ON audit_logs (created_at DESC);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TABLE IF EXISTS audit_logs CASCADE;');
};
