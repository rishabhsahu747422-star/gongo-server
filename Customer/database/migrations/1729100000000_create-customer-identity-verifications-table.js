'use strict';

/**
 * Migration: Create customer_identity_verifications and identity_verification_audits tables
 * for DigiLocker Aadhaar XML verification, with RLS policies, indexes, and triggers.
 *
 * Requirements:
 * - Table: customer_identity_verifications
 * - Minimum metadata columns:
 *   - id (UUID PK)
 *   - customer_id (UUID FK -> users.id)
 *   - document_type (VARCHAR(50))
 *   - verification_status (VARCHAR(50))
 *   - provider (VARCHAR(50))
 *   - provider_reference_id (VARCHAR(255))
 *   - storage_bucket (VARCHAR(100))
 *   - storage_path (VARCHAR(512))
 *   - verified_at (TIMESTAMPTZ)
 *   - consent_record (JSONB)
 *   - created_at (TIMESTAMPTZ)
 *   - updated_at (TIMESTAMPTZ)
 *
 * Security:
 * - Row Level Security (RLS) enabled
 * - Customers can access only their own verification records
 * - Service role has full administrative access
 * - Never store raw Aadhaar XML or unmasked plaintext Aadhaar number in database
 */

exports.shorthands = undefined;

exports.up = async (pgm) => {
  // 1. Create or upgrade customer_identity_verifications table
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS customer_identity_verifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      document_type VARCHAR(50) NOT NULL DEFAULT 'AADHAAR',
      verification_status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
      provider VARCHAR(50) NOT NULL DEFAULT 'DIGILOCKER_SANDBOX',
      verification_provider VARCHAR(50) NOT NULL DEFAULT 'DIGILOCKER_SANDBOX',
      verification_method VARCHAR(30) NOT NULL DEFAULT 'online',
      provider_reference_id VARCHAR(255),
      provider_reference VARCHAR(255),
      storage_bucket VARCHAR(100),
      storage_path VARCHAR(512),
      document_reference VARCHAR(512),
      verified_at TIMESTAMPTZ,
      consent_record JSONB NOT NULL DEFAULT '{}'::jsonb,
      verification_metadata JSONB DEFAULT '{}'::jsonb,
      error_details JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Ensure all columns exist even if table pre-existed with legacy schema
    ALTER TABLE customer_identity_verifications
      ADD COLUMN IF NOT EXISTS provider VARCHAR(50),
      ADD COLUMN IF NOT EXISTS verification_provider VARCHAR(50) DEFAULT 'DIGILOCKER_SANDBOX',
      ADD COLUMN IF NOT EXISTS verification_method VARCHAR(30) DEFAULT 'online',
      ADD COLUMN IF NOT EXISTS provider_reference_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS provider_reference VARCHAR(255),
      ADD COLUMN IF NOT EXISTS storage_bucket VARCHAR(100),
      ADD COLUMN IF NOT EXISTS storage_path VARCHAR(512),
      ADD COLUMN IF NOT EXISTS document_reference VARCHAR(512),
      ADD COLUMN IF NOT EXISTS consent_record JSONB DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS verification_metadata JSONB DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS error_details JSONB;

    -- Update or add check constraints to allow modern states and document types
    ALTER TABLE customer_identity_verifications DROP CONSTRAINT IF EXISTS customer_identity_verifications_status_check;
    ALTER TABLE customer_identity_verifications DROP CONSTRAINT IF EXISTS chk_identity_verif_status;
    ALTER TABLE customer_identity_verifications ADD CONSTRAINT customer_identity_verifications_status_check
      CHECK (verification_status IN ('pending', 'in_progress', 'verified', 'failed', 'rejected', 'expired', 'cancelled', 'PENDING', 'IN_PROGRESS', 'VERIFIED', 'FAILED', 'REJECTED', 'EXPIRED', 'CANCELLED'));

    ALTER TABLE customer_identity_verifications DROP CONSTRAINT IF EXISTS customer_identity_verifications_type_check;
    ALTER TABLE customer_identity_verifications DROP CONSTRAINT IF EXISTS chk_identity_verif_doc_type;
    ALTER TABLE customer_identity_verifications ADD CONSTRAINT customer_identity_verifications_type_check
      CHECK (document_type IN ('aadhaar', 'driving_license', 'passport', 'voter_id', 'AADHAAR', 'DRIVING_LICENSE', 'PASSPORT', 'VOTER_ID'));
  `);

  // 2. Indexes for customer lookup, status filtering, and provider reference uniqueness
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_customer_identity_verif_customer_id
    ON customer_identity_verifications (customer_id);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_customer_identity_verif_provider_ref
    ON customer_identity_verifications (provider_reference_id);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_customer_identity_verif_status
    ON customer_identity_verifications (customer_id, verification_status);
  `);

  // 3. Attach updated_at trigger
  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_customer_identity_verif_updated_at ON customer_identity_verifications;
    CREATE TRIGGER trg_customer_identity_verif_updated_at
    BEFORE UPDATE ON customer_identity_verifications
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);

  // 4. Create identity_verification_audits table
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS identity_verification_audits (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      verification_id UUID REFERENCES customer_identity_verifications(id) ON DELETE SET NULL,
      customer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_type VARCHAR(50) NOT NULL,
      provider VARCHAR(50) NOT NULL DEFAULT 'DIGILOCKER_SANDBOX',
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_id_verif_audits_customer_id
    ON identity_verification_audits (customer_id);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_id_verif_audits_verification_id
    ON identity_verification_audits (verification_id);
  `);

  // 5. Apply Row Level Security (RLS)
  pgm.sql(`
    ALTER TABLE customer_identity_verifications ENABLE ROW LEVEL SECURITY;
    ALTER TABLE identity_verification_audits ENABLE ROW LEVEL SECURITY;

    -- Drop existing policies if any
    DROP POLICY IF EXISTS "customer_identity_verifications_select_own" ON customer_identity_verifications;
    DROP POLICY IF EXISTS "customer_identity_verifications_service_role" ON customer_identity_verifications;
    DROP POLICY IF EXISTS "identity_verification_audits_service_role" ON identity_verification_audits;

    -- Customer read policy: allows customer to read only their own records
    CREATE POLICY "customer_identity_verifications_select_own"
    ON customer_identity_verifications
    FOR SELECT
    USING (
      customer_id = (SELECT id FROM users WHERE auth_id = auth.uid()::text LIMIT 1)
      OR customer_id = auth.uid()
    );

    -- Service role policy: full access for backend
    CREATE POLICY "customer_identity_verifications_service_role"
    ON customer_identity_verifications
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

    -- Audits: Service role access only
    CREATE POLICY "identity_verification_audits_service_role"
    ON identity_verification_audits
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
  `);
};

exports.down = async (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS identity_verification_audits CASCADE;
    DROP TRIGGER IF EXISTS trg_customer_identity_verif_updated_at ON customer_identity_verifications;
    DROP TABLE IF EXISTS customer_identity_verifications CASCADE;
  `);
};
