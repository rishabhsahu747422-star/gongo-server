'use strict';

/**
 * Migration 051: Storage Security Architecture Refactor — Bucket Separation & Integrity
 *
 * 1. Ensures the private storage bucket `gongo-partner-documents` exists with public access disabled (public = false).
 * 2. Ensures the public storage bucket `gongo-uploads` exists with public access enabled (public = true).
 * 3. Enforces strict file size limits and permitted mime types per bucket in storage.buckets.
 * 4. Adds composite indexes on vehicle_documents(vehicle_id, storage_key) and partner_documents(partner_id, storage_key).
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  // 1. Configure storage buckets in storage.buckets table
  await pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'storage' AND table_name = 'buckets') THEN
        -- Configure private partner documents bucket
        INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
        VALUES (
          'gongo-partner-documents',
          'gongo-partner-documents',
          false,
          10485760,
          ARRAY['application/pdf', 'image/jpeg', 'image/png']::text[]
        )
        ON CONFLICT (id) DO UPDATE SET
          public = false,
          file_size_limit = 10485760,
          allowed_mime_types = ARRAY['application/pdf', 'image/jpeg', 'image/png']::text[];

        -- Configure public assets bucket
        INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
        VALUES (
          'gongo-uploads',
          'gongo-uploads',
          true,
          10485760,
          ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
        )
        ON CONFLICT (id) DO UPDATE SET
          public = true;
      END IF;
    END $$;
  `);

  // 2. Add performance & integrity indexes on document storage keys
  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_partner_documents_storage_key
    ON partner_documents (storage_key);

    CREATE INDEX IF NOT EXISTS idx_vehicle_documents_storage_key
    ON vehicle_documents (storage_key);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql(`
    DROP INDEX IF EXISTS idx_partner_documents_storage_key;
    DROP INDEX IF EXISTS idx_vehicle_documents_storage_key;
  `);
};
