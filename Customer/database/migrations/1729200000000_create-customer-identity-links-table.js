'use strict';

/**
 * Migration: Create customer_identity_links table and add identity_hash to customer_identity_verifications
 *
 * Enforces database-level uniqueness on verified customer identities to prevent the same Aadhaar
 * identity from being verified across multiple customer accounts simultaneously.
 */

exports.shorthands = undefined;

exports.up = async (pgm) => {
  // 1. Create customer_identity_links table
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS customer_identity_links (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      identity_hash VARCHAR(64) NOT NULL,
      id_type VARCHAR(50) NOT NULL DEFAULT 'AADHAAR',
      verification_id UUID REFERENCES customer_identity_verifications(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_customer_identity_links_hash UNIQUE (identity_hash)
    );
  `);

  // 2. Indexes for customer lookup and identity hash
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_customer_identity_links_customer_id
    ON customer_identity_links (customer_id);

    ALTER TABLE customer_identity_verifications
      ADD COLUMN IF NOT EXISTS identity_hash VARCHAR(64);

    CREATE INDEX IF NOT EXISTS idx_customer_identity_verif_identity_hash
    ON customer_identity_verifications (identity_hash);
  `);

  // 3. Attach updated_at trigger
  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_customer_identity_links_updated_at ON customer_identity_links;
    CREATE TRIGGER trg_customer_identity_links_updated_at
    BEFORE UPDATE ON customer_identity_links
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS customer_identity_links CASCADE;
    DROP INDEX IF EXISTS idx_customer_identity_verif_identity_hash;
    ALTER TABLE customer_identity_verifications DROP COLUMN IF EXISTS identity_hash;
  `);
};
