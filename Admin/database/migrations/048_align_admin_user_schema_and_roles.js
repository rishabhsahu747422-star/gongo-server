'use strict';

/**
 * Migration 048: Align Admin User Schema, Supported Roles, and Audit Table Nullability.
 *
 * Requirements:
 * - Support super_admin alongside admin and support_executive in users_role_check constraint.
 * - Allow created_by column on users table to track provisioning administrator.
 * - Allow phone to be nullable on users table for email-provisioned admin accounts.
 * - Ensure admin_actions allows append-only audit rows where legacy admin_id, action_type, and target_type
 *   are decoupled from the canonical actor_id, action, and target_resource columns.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    -- 1. Update users_role_check to include super_admin
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (((role)::text = ANY ((ARRAY['customer'::character varying, 'partner'::character varying, 'admin'::character varying, 'super_admin'::character varying, 'support_executive'::character varying])::text[])));

    -- 2. Add created_by column to users table if not exists
    ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

    -- 3. Make phone column nullable on users table for email-only admin accounts
    ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;

    -- 4. Reconcile admin_actions nullability for decoupled audit schemas
    ALTER TABLE admin_actions ALTER COLUMN admin_id DROP NOT NULL;
    ALTER TABLE admin_actions ALTER COLUMN action_type DROP NOT NULL;
    ALTER TABLE admin_actions ALTER COLUMN target_type DROP NOT NULL;
  `);
};

exports.down = async (pgm) => {
  await pgm.sql(`
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (((role)::text = ANY ((ARRAY['customer'::character varying, 'partner'::character varying, 'admin'::character varying, 'support_executive'::character varying])::text[])));
    ALTER TABLE users DROP COLUMN IF EXISTS created_by;
  `);
};
