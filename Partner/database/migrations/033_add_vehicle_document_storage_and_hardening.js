'use strict';

/**
 * Migration 033: Add Vehicle Document Storage, Pickup Location & Inventory Hardening.
 *
 * 1. Adds `pickup_location` column to `vehicles` table.
 * 2. Updates `storage_uploads.entity_type` constraint to include 'VEHICLE_DOCUMENT'.
 * 3. Updates `storage_uploads.document_type` constraint to support vehicle document types.
 * 4. Adds composite indexes for efficient inventory queries.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  // 1. Add pickup_location column to vehicles
  await pgm.sql(`
    ALTER TABLE vehicles
    ADD COLUMN IF NOT EXISTS pickup_location TEXT;
  `);

  // 2. Update storage_uploads entity_type constraint to permit VEHICLE_DOCUMENT
  await pgm.sql(`
    ALTER TABLE storage_uploads
    DROP CONSTRAINT IF EXISTS chk_storage_uploads_entity_type;

    ALTER TABLE storage_uploads
    ADD CONSTRAINT chk_storage_uploads_entity_type
    CHECK (entity_type IN ('PROFILE_IMAGE', 'KYC_DOCUMENT', 'VEHICLE_IMAGE', 'VEHICLE_DOCUMENT'));
  `);

  // 3. Update storage_uploads document_type constraint to permit vehicle document types
  await pgm.sql(`
    ALTER TABLE storage_uploads
    DROP CONSTRAINT IF EXISTS chk_storage_uploads_doc_type;

    ALTER TABLE storage_uploads
    ADD CONSTRAINT chk_storage_uploads_doc_type
    CHECK (
      document_type IS NULL OR document_type IN (
        'AADHAAR', 'PAN', 'GST', 'SHOP_ESTABLISHMENT',
        'RC', 'Insurance', 'PUC', 'Fitness', 'Other'
      )
    );
  `);

  // 4. Create composite indexes for partner inventory queries
  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicles_partner_archived_status
    ON vehicles (partner_id, is_archived, manual_status);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP INDEX IF EXISTS idx_vehicles_partner_archived_status;');

  await pgm.sql(`
    ALTER TABLE storage_uploads
    DROP CONSTRAINT IF EXISTS chk_storage_uploads_doc_type;

    ALTER TABLE storage_uploads
    ADD CONSTRAINT chk_storage_uploads_doc_type
    CHECK (document_type IS NULL OR document_type IN ('AADHAAR', 'PAN', 'GST', 'SHOP_ESTABLISHMENT'));
  `);

  await pgm.sql(`
    ALTER TABLE storage_uploads
    DROP CONSTRAINT IF EXISTS chk_storage_uploads_entity_type;

    ALTER TABLE storage_uploads
    ADD CONSTRAINT chk_storage_uploads_entity_type
    CHECK (entity_type IN ('PROFILE_IMAGE', 'KYC_DOCUMENT', 'VEHICLE_IMAGE'));
  `);

  await pgm.sql(`
    ALTER TABLE vehicles
    DROP COLUMN IF EXISTS pickup_location;
  `);
};
