'use strict';

/**
 * Migration: Create admin permissions table for granular administrative RBAC.
 *
 * Requirements:
 * - Foreign key referencing canonical users(id) table
 * - Permission group classification conforming to architecture specification:
 *   SUPER_ADMIN, OPERATIONS_ADMIN, FINANCE_ADMIN, SUPPORT_ADMIN, VERIFICATION_ADMIN
 * - Assigned by audit reference
 * - Unique constraint on (user_id, permission)
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS admin_permissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission VARCHAR(50) NOT NULL,
      assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_admin_permissions_user_permission UNIQUE (user_id, permission),
      CONSTRAINT chk_admin_permissions_permission CHECK (
        permission IN (
          'SUPER_ADMIN',
          'OPERATIONS_ADMIN',
          'FINANCE_ADMIN',
          'SUPPORT_ADMIN',
          'VERIFICATION_ADMIN'
        )
      )
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_admin_permissions_user_id
    ON admin_permissions (user_id);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_admin_permissions_permission
    ON admin_permissions (permission);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP INDEX IF EXISTS idx_admin_permissions_permission;');
  await pgm.sql('DROP INDEX IF EXISTS idx_admin_permissions_user_id;');
  await pgm.sql('DROP TABLE IF EXISTS admin_permissions CASCADE;');
};
