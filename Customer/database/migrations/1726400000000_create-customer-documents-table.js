'use strict';

/**
 * Migration: Create customer_documents table with constraints, indexes, and triggers.
 *
 * Supported Document Types:
 * - DRIVING_LICENSE (primary document type for vehicle rentals)
 * - PASSPORT
 * - AADHAAR
 * - VOTER_ID
 *
 * Supported Document Statuses:
 * - PENDING
 * - VERIFIED
 * - REJECTED
 * - EXPIRED
 *
 * Security & Integrity:
 * - UUID v4 primary key via pgcrypto gen_random_uuid()
 * - Foreign key cascade to users(id)
 * - Check constraints enforcing valid document_type and status
 * - Never stores raw document blobs in PostgreSQL
 * - storage_key is an opaque reference to external storage (S3)
 * - Automatic updated_at timestamp maintenance via trigger
 */

exports.shorthands = undefined;

exports.up = async (pgm) => {
  // 1. Create customer_documents table
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS customer_documents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      document_type VARCHAR(50) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
      storage_key VARCHAR(512),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      rejection_reason TEXT,
      verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_customer_documents_type CHECK (
        document_type IN ('DRIVING_LICENSE', 'PASSPORT', 'AADHAAR', 'VOTER_ID')
      ),
      CONSTRAINT chk_customer_documents_status CHECK (
        status IN ('PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED')
      )
    );
  `);

  // 2. Create indexes
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_customer_documents_user_id
    ON customer_documents (user_id);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_customer_documents_user_type
    ON customer_documents (user_id, document_type);
  `);

  // 3. Attach updated_at trigger (reuses update_updated_at_column created in migration 1)
  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_customer_documents_updated_at ON customer_documents;
    CREATE TRIGGER trg_customer_documents_updated_at
    BEFORE UPDATE ON customer_documents
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  pgm.sql('DROP TRIGGER IF EXISTS trg_customer_documents_updated_at ON customer_documents;');
  pgm.sql('DROP TABLE IF EXISTS customer_documents CASCADE;');
};
