'use strict';

/**
 * Migration: Create canonical disputes table for Admin Damage & Dispute Management.
 *
 * DESIGN DECISIONS:
 *   - disputes:
 *       - booking_id: References bookings(id) ON DELETE RESTRICT (audit ledger).
 *       - customer_id: References users(id) ON DELETE RESTRICT.
 *       - partner_id: References partners(id) ON DELETE RESTRICT.
 *       - vehicle_id: References vehicles(id) ON DELETE SET NULL.
 *       - damage_report_id: References damage_reports(id) ON DELETE SET NULL.
 *       - claimant_id: References users(id) ON DELETE RESTRICT.
 *       - respondent_id: References users(id) ON DELETE SET NULL.
 *       - assigned_to: References users(id) ON DELETE SET NULL.
 *       - resolved_by: References users(id) ON DELETE SET NULL.
 *       - status: 'OPEN', 'UNDER_INVESTIGATION', 'RESOLVED', 'REJECTED', 'CLOSED'
 *       - priority: 'LOW', 'MEDIUM', 'HIGH', 'URGENT'
 *       - dispute_type: 'DAMAGE_CHARGE', 'SECURITY_DEPOSIT', 'OVERCHARGE',
 *                      'CANCELLATION_FEE', 'LATE_RETURN', 'GENERAL'
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS disputes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      dispute_number VARCHAR(50) NOT NULL UNIQUE,
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
      customer_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
      vehicle_id UUID REFERENCES vehicles(id) ON DELETE SET NULL,
      damage_report_id UUID REFERENCES damage_reports(id) ON DELETE SET NULL,
      claimant_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      respondent_id UUID REFERENCES users(id) ON DELETE SET NULL,
      dispute_type VARCHAR(50) NOT NULL DEFAULT 'GENERAL',
      status VARCHAR(30) NOT NULL DEFAULT 'OPEN',
      priority VARCHAR(20) NOT NULL DEFAULT 'MEDIUM',
      disputed_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
      settled_amount NUMERIC(12,2) DEFAULT 0.00,
      currency VARCHAR(10) NOT NULL DEFAULT 'INR',
      description TEXT NOT NULL,
      evidence TEXT[] DEFAULT '{}',
      assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
      assigned_at TIMESTAMPTZ,
      resolution TEXT,
      resolution_reason TEXT,
      resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
      resolved_at TIMESTAMPTZ,
      rejection_reason TEXT,
      financial_action VARCHAR(50),
      financial_reference_id VARCHAR(100),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT chk_disputes_disputed_amount CHECK (disputed_amount >= 0.00),
      CONSTRAINT chk_disputes_settled_amount CHECK (settled_amount IS NULL OR settled_amount >= 0.00),
      CONSTRAINT chk_disputes_status CHECK (
        status IN ('OPEN', 'UNDER_INVESTIGATION', 'RESOLVED', 'REJECTED', 'CLOSED')
      ),
      CONSTRAINT chk_disputes_priority CHECK (
        priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT')
      ),
      CONSTRAINT chk_disputes_type CHECK (
        dispute_type IN ('DAMAGE_CHARGE', 'SECURITY_DEPOSIT', 'OVERCHARGE', 'CANCELLATION_FEE', 'LATE_RETURN', 'GENERAL')
      )
    );

    ALTER TABLE disputes
      ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES users(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS partner_id UUID REFERENCES partners(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS vehicle_id UUID REFERENCES vehicles(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS damage_report_id UUID REFERENCES damage_reports(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS claimant_id UUID REFERENCES users(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS respondent_id UUID REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS disputed_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
      ADD COLUMN IF NOT EXISTS settled_amount NUMERIC(12,2) DEFAULT 0.00,
      ADD COLUMN IF NOT EXISTS currency VARCHAR(10) NOT NULL DEFAULT 'INR',
      ADD COLUMN IF NOT EXISTS evidence TEXT[] DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS resolution_reason TEXT,
      ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
      ADD COLUMN IF NOT EXISTS financial_action VARCHAR(50),
      ADD COLUMN IF NOT EXISTS financial_reference_id VARCHAR(100),
      ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_disputes_booking_id ON disputes (booking_id);
    CREATE INDEX IF NOT EXISTS idx_disputes_customer_id ON disputes (customer_id);
    CREATE INDEX IF NOT EXISTS idx_disputes_partner_id ON disputes (partner_id);
    CREATE INDEX IF NOT EXISTS idx_disputes_vehicle_id ON disputes (vehicle_id);
    CREATE INDEX IF NOT EXISTS idx_disputes_damage_report_id ON disputes (damage_report_id);
    CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes (status);
    CREATE INDEX IF NOT EXISTS idx_disputes_assigned_to ON disputes (assigned_to);
    CREATE INDEX IF NOT EXISTS idx_disputes_created_at ON disputes (created_at DESC);
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_disputes_updated_at ON disputes;
    CREATE TRIGGER trg_disputes_updated_at
    BEFORE UPDATE ON disputes
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TRIGGER IF EXISTS trg_disputes_updated_at ON disputes;');
  await pgm.sql('DROP TABLE IF EXISTS disputes CASCADE;');
};
