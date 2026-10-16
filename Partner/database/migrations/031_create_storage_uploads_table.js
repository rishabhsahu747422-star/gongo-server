'use strict';

/**
 * Migration 031: Create storage_uploads table.
 * Tracks asynchronous presigned S3 upload lifecycle and verifies binary
 * existence prior to PostgreSQL domain synchronization.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS storage_uploads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
      entity_type VARCHAR(50) NOT NULL,
      entity_id UUID,
      document_type VARCHAR(50),
      storage_key VARCHAR(500) NOT NULL,
      content_type VARCHAR(100) NOT NULL,
      expected_size_bytes BIGINT,
      actual_size_bytes BIGINT,
      status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
      expires_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_storage_uploads_status CHECK (status IN ('PENDING', 'COMPLETED', 'EXPIRED', 'FAILED')),
      CONSTRAINT chk_storage_uploads_entity_type CHECK (entity_type IN ('PROFILE_IMAGE', 'KYC_DOCUMENT', 'VEHICLE_IMAGE'))
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_storage_uploads_partner_id
    ON storage_uploads (partner_id);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_storage_uploads_status
    ON storage_uploads (status);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_storage_uploads_expires_at
    ON storage_uploads (expires_at);
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_storage_uploads_updated_at ON storage_uploads;
    CREATE TRIGGER trg_storage_uploads_updated_at
    BEFORE UPDATE ON storage_uploads
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TRIGGER IF EXISTS trg_storage_uploads_updated_at ON storage_uploads;');
  await pgm.sql('DROP TABLE IF EXISTS storage_uploads CASCADE;');
};
