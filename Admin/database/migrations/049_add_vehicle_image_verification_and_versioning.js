'use strict';

exports.shorthands = undefined;

/**
 * Migration 049: Vehicle Image Verification and Versioning (Admin Alignment)
 *
 * Adds verification lifecycle tracking, audit rejection reasons,
 * and versioning columns to vehicle_images table.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = async (pgm) => {
  await pgm.sql(`
    ALTER TABLE vehicle_images ADD COLUMN IF NOT EXISTS verification_status VARCHAR(30) DEFAULT 'PENDING';
    ALTER TABLE vehicle_images ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
    ALTER TABLE vehicle_images ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;
    ALTER TABLE vehicle_images ADD COLUMN IF NOT EXISTS parent_image_id UUID;
    ALTER TABLE vehicle_images ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
    ALTER TABLE vehicle_images ADD COLUMN IF NOT EXISTS verified_by UUID;
    ALTER TABLE vehicle_images ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_vehicle_images_verification_status ON vehicle_images(vehicle_id, verification_status);
    CREATE INDEX IF NOT EXISTS idx_vehicle_images_parent_id ON vehicle_images(parent_image_id);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql(`
    DROP INDEX IF EXISTS idx_vehicle_images_verification_status;
    DROP INDEX IF EXISTS idx_vehicle_images_parent_id;
    ALTER TABLE vehicle_images DROP COLUMN IF EXISTS verification_status;
    ALTER TABLE vehicle_images DROP COLUMN IF EXISTS rejection_reason;
    ALTER TABLE vehicle_images DROP COLUMN IF EXISTS version;
    ALTER TABLE vehicle_images DROP COLUMN IF EXISTS parent_image_id;
    ALTER TABLE vehicle_images DROP COLUMN IF EXISTS verified_at;
    ALTER TABLE vehicle_images DROP COLUMN IF EXISTS verified_by;
    ALTER TABLE vehicle_images DROP COLUMN IF EXISTS rejected_at;
  `);
};
