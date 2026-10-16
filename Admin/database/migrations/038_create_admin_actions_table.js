'use strict';

/**
 * Migration: Create persistent admin actions audit log.
 *
 * Requirements:
 * - Append-only audit log for all administrative state mutations and decisions
 * - UUID primary key
 * - Foreign key referencing canonical users(id) table
 * - Permission and role metadata
 * - Action and target resource classification
 * - Request correlation tracking
 * - Before and after state capture for dispute/audit review
 * - Structured metadata with sensitive-value redaction
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS admin_actions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_id UUID REFERENCES users(id) ON DELETE RESTRICT,
      actor_role VARCHAR(50) NOT NULL DEFAULT 'ADMIN',
      permission VARCHAR(100),
      action VARCHAR(100),
      target_resource VARCHAR(100),
      target_resource_id VARCHAR(128),
      request_id VARCHAR(128),
      ip_address VARCHAR(45),
      user_agent TEXT,
      before_state JSONB,
      after_state JSONB,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_admin_actions_action CHECK (action IS NOT NULL AND action != ''),
      CONSTRAINT chk_admin_actions_target_resource CHECK (target_resource IS NOT NULL AND target_resource != '')
    );

    ALTER TABLE admin_actions
      ADD COLUMN IF NOT EXISTS actor_id UUID REFERENCES users(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS actor_role VARCHAR(50) NOT NULL DEFAULT 'ADMIN',
      ADD COLUMN IF NOT EXISTS permission VARCHAR(100),
      ADD COLUMN IF NOT EXISTS action VARCHAR(100),
      ADD COLUMN IF NOT EXISTS target_resource VARCHAR(100),
      ADD COLUMN IF NOT EXISTS target_resource_id VARCHAR(128),
      ADD COLUMN IF NOT EXISTS request_id VARCHAR(128),
      ADD COLUMN IF NOT EXISTS ip_address VARCHAR(45),
      ADD COLUMN IF NOT EXISTS user_agent TEXT,
      ADD COLUMN IF NOT EXISTS before_state JSONB,
      ADD COLUMN IF NOT EXISTS after_state JSONB,
      ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_admin_actions_actor_id
    ON admin_actions (actor_id);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_admin_actions_resource
    ON admin_actions (target_resource, target_resource_id);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_admin_actions_action
    ON admin_actions (action);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_admin_actions_created_at
    ON admin_actions (created_at DESC);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_admin_actions_request_id
    ON admin_actions (request_id)
    WHERE request_id IS NOT NULL;
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP INDEX IF EXISTS idx_admin_actions_request_id;');
  await pgm.sql('DROP INDEX IF EXISTS idx_admin_actions_created_at;');
  await pgm.sql('DROP INDEX IF EXISTS idx_admin_actions_action;');
  await pgm.sql('DROP INDEX IF EXISTS idx_admin_actions_resource;');
  await pgm.sql('DROP INDEX IF EXISTS idx_admin_actions_actor_id;');
  await pgm.sql('DROP TABLE IF EXISTS admin_actions CASCADE;');
};
