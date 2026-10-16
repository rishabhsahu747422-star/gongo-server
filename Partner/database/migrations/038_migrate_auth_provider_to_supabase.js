'use strict';

exports.shorthands = undefined;

/**
 * Migration 038: Migrate default auth provider from 'firebase' to 'supabase'
 * and update existing user records.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = async (pgm) => {
  await pgm.sql(`
    ALTER TABLE users ALTER COLUMN auth_provider SET DEFAULT 'supabase';
    UPDATE users SET auth_provider = 'supabase' WHERE auth_provider = 'firebase';
  `);
};

exports.down = async (pgm) => {
  await pgm.sql(`
    ALTER TABLE users ALTER COLUMN auth_provider SET DEFAULT 'firebase';
    UPDATE users SET auth_provider = 'firebase' WHERE auth_provider = 'supabase';
  `);
};
