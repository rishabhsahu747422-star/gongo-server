'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS vehicle_documents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      document_type VARCHAR(50) NOT NULL,
      document_name VARCHAR(150),
      document_number VARCHAR(100),
      valid_till DATE,
      storage_key VARCHAR(500) NOT NULL,
      verification_status VARCHAR(30) NOT NULL DEFAULT 'VERIFIED',
      is_required BOOLEAN NOT NULL DEFAULT true,
      version INTEGER NOT NULL DEFAULT 1,
      rejection_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_veh_docs_type CHECK (document_type IN ('RC', 'Insurance', 'PUC', 'Fitness', 'Other')),
      CONSTRAINT chk_veh_docs_status CHECK (verification_status IN ('PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED')),
      CONSTRAINT chk_veh_docs_version CHECK (version >= 1),
      CONSTRAINT uq_vehicle_doc_type_version UNIQUE (vehicle_id, document_type, version)
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicle_documents_vehicle_id
    ON vehicle_documents (vehicle_id);
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_vehicle_documents_updated_at ON vehicle_documents;
    CREATE TRIGGER trg_vehicle_documents_updated_at
    BEFORE UPDATE ON vehicle_documents
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TRIGGER IF EXISTS trg_vehicle_documents_updated_at ON vehicle_documents;');
  await pgm.sql('DROP TABLE IF EXISTS vehicle_documents CASCADE;');
};
