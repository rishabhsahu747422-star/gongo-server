'use strict';

/**
 * Migration 032: Reconcile Schema, Canonicalize Partner Business Entity & Hardening.
 *
 * 1. Consolidates business profile & hub location fields into canonical `partners` table.
 * 2. Enforces canonical KYC document types (AADHAAR, PAN, GST, SHOP_ESTABLISHMENT).
 * 3. Reconciles booking statuses to explicitly include PENDING_PAYMENT and CONFIRMED.
 * 4. Documents `shops` table as legacy compatibility infrastructure.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  // 1. Add canonical business & location columns directly to partners
  await pgm.sql(`
    ALTER TABLE partners
    ADD COLUMN IF NOT EXISTS business_name VARCHAR(200),
    ADD COLUMN IF NOT EXISTS business_address TEXT,
    ADD COLUMN IF NOT EXISTS city VARCHAR(100),
    ADD COLUMN IF NOT EXISTS latitude NUMERIC(10,7),
    ADD COLUMN IF NOT EXISTS longitude NUMERIC(10,7),
    ADD COLUMN IF NOT EXISTS operating_info VARCHAR(200);
  `);

  // 2. Backfill business & location details from shops into partners where available
  await pgm.sql(`
    UPDATE partners
    SET 
      business_name = shops.shop_name,
      business_address = shops.shop_address,
      city = shops.city,
      latitude = shops.latitude,
      longitude = shops.longitude,
      operating_info = shops.operating_info
    FROM shops
    WHERE shops.partner_id = partners.id;
  `);

  // 3. Add CHECK constraint to partner_documents for canonical document types
  await pgm.sql(`
    ALTER TABLE partner_documents
    DROP CONSTRAINT IF EXISTS chk_partner_docs_document_type;

    ALTER TABLE partner_documents
    ADD CONSTRAINT chk_partner_docs_document_type
    CHECK (document_type IN ('AADHAAR', 'PAN', 'GST', 'SHOP_ESTABLISHMENT'));
  `);

  // 4. Update bookings status constraint to include PENDING_PAYMENT and CONFIRMED
  await pgm.sql(`
    ALTER TABLE bookings
    DROP CONSTRAINT IF EXISTS chk_bookings_status;

    ALTER TABLE bookings
    ADD CONSTRAINT chk_bookings_status
    CHECK (booking_status IN ('PENDING_PAYMENT', 'CONFIRMED', 'UPCOMING', 'ACTIVE', 'COMPLETED', 'CANCELLED'));
  `);

  // 5. Add CHECK constraint to storage_uploads document_type
  await pgm.sql(`
    ALTER TABLE storage_uploads
    DROP CONSTRAINT IF EXISTS chk_storage_uploads_doc_type;

    ALTER TABLE storage_uploads
    ADD CONSTRAINT chk_storage_uploads_doc_type
    CHECK (document_type IS NULL OR document_type IN ('AADHAAR', 'PAN', 'GST', 'SHOP_ESTABLISHMENT'));
  `);

  // 6. Create index on partners.city
  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_partners_city
    ON partners (city);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP INDEX IF EXISTS idx_partners_city;');
  await pgm.sql('ALTER TABLE storage_uploads DROP CONSTRAINT IF EXISTS chk_storage_uploads_doc_type;');
  await pgm.sql(`
    ALTER TABLE bookings
    DROP CONSTRAINT IF EXISTS chk_bookings_status;

    ALTER TABLE bookings
    ADD CONSTRAINT chk_bookings_status
    CHECK (booking_status IN ('UPCOMING', 'ACTIVE', 'COMPLETED', 'CANCELLED'));
  `);
  await pgm.sql('ALTER TABLE partner_documents DROP CONSTRAINT IF EXISTS chk_partner_docs_document_type;');
  await pgm.sql(`
    ALTER TABLE partners
    DROP COLUMN IF EXISTS business_name,
    DROP COLUMN IF EXISTS business_address,
    DROP COLUMN IF EXISTS city,
    DROP COLUMN IF EXISTS latitude,
    DROP COLUMN IF EXISTS longitude,
    DROP COLUMN IF EXISTS operating_info;
  `);
};
