'use strict';

/**
 * Migration: Update admin_permissions table to support granular domain.action permissions.
 *
 * Drops the original restrictive CHECK constraint that only allowed:
 *   SUPER_ADMIN, OPERATIONS_ADMIN, FINANCE_ADMIN, SUPPORT_ADMIN, VERIFICATION_ADMIN
 *
 * The application layer (PERMISSIONS constant + VALID_PERMISSIONS set in
 * src/constants/permissions.js) now serves as the canonical allowlist for all
 * valid permission strings. This defense-in-depth approach keeps the DB flexible
 * while the application strictly enforces the permission catalog.
 *
 * The existing UNIQUE(user_id, permission) constraint and VARCHAR(50) column
 * definition provide sufficient DB-level protection.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  // Drop the restrictive CHECK constraint to allow granular domain.action permissions
  await pgm.sql(`
    ALTER TABLE admin_permissions
    DROP CONSTRAINT IF EXISTS chk_admin_permissions_permission;
  `);
};

exports.down = async (pgm) => {
  // Restore original restrictive CHECK constraint
  await pgm.sql(`
    ALTER TABLE admin_permissions
    ADD CONSTRAINT chk_admin_permissions_permission CHECK (
      permission IN (
        'SUPER_ADMIN',
        'OPERATIONS_ADMIN',
        'FINANCE_ADMIN',
        'SUPPORT_ADMIN',
        'VERIFICATION_ADMIN'
      )
    );
  `);
};
