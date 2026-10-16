'use strict';

exports.shorthands = undefined;

/**
 * Migration 039: Supabase Database Schema Alignment
 *
 * Adds safe additive columns to users, partners, and shops tables for
 * seamless interoperability with the canonical Supabase schema.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = async (pgm) => {
  await pgm.sql(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_id VARCHAR(128);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(255);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_auth_id ON users(auth_id) WHERE auth_id IS NOT NULL;
  `);

  await pgm.sql(`
    ALTER TABLE partners ADD COLUMN IF NOT EXISTS profile_image_url TEXT;
    ALTER TABLE partners ADD COLUMN IF NOT EXISTS rating NUMERIC(3,2) DEFAULT 5.0;
    ALTER TABLE partners ADD COLUMN IF NOT EXISTS review_count INTEGER DEFAULT 0;
    ALTER TABLE partners ADD COLUMN IF NOT EXISTS registered_since VARCHAR(50);
    ALTER TABLE partners ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
  `);

  await pgm.sql(`
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS operating_info TEXT DEFAULT '08:00 AM - 10:00 PM (All Days)';
  `);
};

exports.down = async (pgm) => {
  await pgm.sql(`
    DROP INDEX IF EXISTS idx_users_auth_id;
  `);
};
