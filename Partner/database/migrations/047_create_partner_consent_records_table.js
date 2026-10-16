'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS partner_consents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      partner_id UUID REFERENCES partners(id) ON DELETE CASCADE,
      document_type VARCHAR(50) NOT NULL,
      document_version VARCHAR(50) NOT NULL,
      content_hash VARCHAR(128) NOT NULL,
      accepted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ip_address VARCHAR(45),
      user_agent TEXT,
      vehicle_id UUID REFERENCES vehicles(id) ON DELETE SET NULL,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_partner_consents_doc_type CHECK (document_type IN ('GONGO_TERMS', 'VEHICLE_LEASE_AGREEMENT'))
    );

    CREATE INDEX IF NOT EXISTS idx_partner_consents_user_doc
      ON partner_consents (user_id, document_type, accepted_at DESC);

    CREATE INDEX IF NOT EXISTS idx_partner_consents_partner_doc
      ON partner_consents (partner_id, document_type, accepted_at DESC);

    CREATE INDEX IF NOT EXISTS idx_partner_consents_vehicle
      ON partner_consents (vehicle_id);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql(`
    DROP TABLE IF EXISTS partner_consents CASCADE;
  `);
};
