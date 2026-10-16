'use strict';

/**
 * Migration: Minimal partner + shop scaffold for vehicle ownership.
 *
 * DESIGN DECISION — Scope intentionally limited:
 *   This migration creates only the minimum schema required for the Customer
 *   discovery module (Step 6) to enforce ownership eligibility rules:
 *
 *     users → partners → shops → vehicles
 *
 *   Full partner management (KYC uploads, approval workflows, document
 *   verification, partner dashboards) is deferred to the Partner Backend module
 *   and will be implemented in a later step.
 *
 * SECURITY:
 *   - KYC and identity documents are NOT stored here.
 *   - Registration-level contact info is intentionally omitted.
 *   - Customer discovery queries join on eligibility flags only.
 *
 * Eligibility rules enforced by the discovery layer:
 *   - partner.verification_status = 'approved'
 *   - partner.is_active = true
 *   - shop.is_active = true
 */

exports.shorthands = undefined;

exports.up = async (pgm) => {
  // ── 1. Partners table ──────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS partners (
      id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id             UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      business_name       VARCHAR(200),
      verification_status VARCHAR(20) NOT NULL DEFAULT 'pending',
      is_active           BOOLEAN     NOT NULL DEFAULT false,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_partners_verification_status CHECK (
        verification_status IN ('pending', 'under_review', 'approved', 'rejected', 'suspended')
      ),
      CONSTRAINT uq_partners_user_id UNIQUE (user_id)
    );
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_partners_user_id
    ON partners (user_id);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_partners_verification_status
    ON partners (verification_status);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_partners_is_active
    ON partners (is_active);
  `);

  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_partners_updated_at ON partners;
    CREATE TRIGGER trg_partners_updated_at
    BEFORE UPDATE ON partners
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);

  // ── 2. Shops table ─────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS shops (
      id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      partner_id  UUID        NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
      shop_name   VARCHAR(200) NOT NULL,
      description TEXT,
      is_active   BOOLEAN     NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_shops_partner_id
    ON shops (partner_id);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_shops_is_active
    ON shops (is_active);
  `);

  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_shops_updated_at ON shops;
    CREATE TRIGGER trg_shops_updated_at
    BEFORE UPDATE ON shops
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  pgm.sql('DROP TRIGGER IF EXISTS trg_shops_updated_at ON shops;');
  pgm.sql('DROP TABLE IF EXISTS shops CASCADE;');
  pgm.sql('DROP TRIGGER IF EXISTS trg_partners_updated_at ON partners;');
  pgm.sql('DROP TABLE IF EXISTS partners CASCADE;');
};
