'use strict';

/**
 * Migration: Add avatar_storage_key to users table.
 *
 * Stores opaque reference to customer profile avatar image in private S3 bucket.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS avatar_storage_key VARCHAR(512);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql(`
    ALTER TABLE users
    DROP COLUMN IF EXISTS avatar_storage_key;
  `);
};
