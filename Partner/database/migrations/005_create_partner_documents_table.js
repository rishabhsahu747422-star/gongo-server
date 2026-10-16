'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS partner_documents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
      document_type VARCHAR(50) NOT NULL,
      document_number VARCHAR(100),
      storage_key VARCHAR(500) NOT NULL,
      verification_status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
      version INTEGER NOT NULL DEFAULT 1,
      rejection_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_partner_docs_status CHECK (verification_status IN ('PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED')),
      CONSTRAINT chk_partner_docs_version CHECK (version >= 1),
      CONSTRAINT uq_partner_doc_type_version UNIQUE (partner_id, document_type, version)
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_partner_documents_partner_id
    ON partner_documents (partner_id);
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_partner_documents_updated_at ON partner_documents;
    CREATE TRIGGER trg_partner_documents_updated_at
    BEFORE UPDATE ON partner_documents
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TRIGGER IF EXISTS trg_partner_documents_updated_at ON partner_documents;');
  await pgm.sql('DROP TABLE IF EXISTS partner_documents CASCADE;');
};
