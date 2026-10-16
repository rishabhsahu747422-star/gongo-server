'use strict';

/**
 * Migration: Create canonical refunds and commission_rules tables for Admin Financial Operations.
 *
 * DESIGN DECISIONS:
 *   - refunds:
 *       - booking_id: References bookings(id) ON DELETE RESTRICT (audit ledger).
 *       - payment_id: References payments(id) ON DELETE RESTRICT.
 *       - customer_id: References users(id) ON DELETE RESTRICT.
 *       - requested_amount: NUMERIC(12,2) with positive check constraint.
 *       - approved_amount: NUMERIC(12,2) with non-negative check constraint.
 *       - refunded_amount: NUMERIC(12,2) with non-negative check constraint.
 *       - status: 'REQUESTED', 'UNDER_REVIEW', 'COMPLETED', 'REJECTED', 'FAILED'.
 *       - idempotency_key: Unique index for deduplication and retry protection.
 *   - commission_rules:
 *       - Configurable commission rules hierarchy: vehicle > partner > category > default.
 *       - Historical commission_records remain immutable.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  // 1. Canonical refunds table
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS refunds (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      refund_number VARCHAR(50) NOT NULL UNIQUE,
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
      payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
      customer_id UUID REFERENCES users(id) ON DELETE RESTRICT,
      requested_amount NUMERIC(12,2) NOT NULL,
      approved_amount NUMERIC(12,2),
      refunded_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
      currency VARCHAR(10) NOT NULL DEFAULT 'INR',
      reason TEXT NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'REQUESTED',
      provider VARCHAR(30) NOT NULL DEFAULT 'CASHFREE',
      provider_refund_id VARCHAR(100),
      idempotency_key VARCHAR(100),
      rejection_reason TEXT,
      processed_by UUID REFERENCES users(id),
      processed_at TIMESTAMPTZ,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT chk_refunds_requested_amount CHECK (requested_amount > 0),
      CONSTRAINT chk_refunds_approved_amount CHECK (approved_amount IS NULL OR approved_amount >= 0),
      CONSTRAINT chk_refunds_refunded_amount CHECK (refunded_amount >= 0),
      CONSTRAINT chk_refunds_status CHECK (
        status IN ('REQUESTED', 'UNDER_REVIEW', 'COMPLETED', 'REJECTED', 'FAILED')
      )
    );

    ALTER TABLE refunds
      ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES users(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS provider VARCHAR(30) DEFAULT 'CASHFREE',
      ADD COLUMN IF NOT EXISTS provider_refund_id VARCHAR(100),
      ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(100),
      ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
      ADD COLUMN IF NOT EXISTS processed_by UUID REFERENCES users(id),
      ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS metadata JSONB;
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_refunds_booking_id ON refunds (booking_id);
    CREATE INDEX IF NOT EXISTS idx_refunds_payment_id ON refunds (payment_id);
    CREATE INDEX IF NOT EXISTS idx_refunds_customer_id ON refunds (customer_id);
    CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds (status);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_refunds_idempotency_key
      ON refunds (idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_refunds_updated_at ON refunds;
    CREATE TRIGGER trg_refunds_updated_at
    BEFORE UPDATE ON refunds
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);

  // 2. Canonical commission_rules table
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS commission_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) NOT NULL,
      rule_scope VARCHAR(30) NOT NULL DEFAULT 'default',
      commission_type VARCHAR(30) NOT NULL DEFAULT 'percentage',
      commission_value NUMERIC(7,2) NOT NULL,
      priority INTEGER NOT NULL DEFAULT 10,
      target_id UUID,
      target_name VARCHAR(150),
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by UUID REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT chk_commission_rules_scope CHECK (
        rule_scope IN ('default', 'category', 'partner', 'vehicle')
      ),
      CONSTRAINT chk_commission_rules_type CHECK (
        commission_type IN ('percentage', 'flat')
      ),
      CONSTRAINT chk_commission_rules_val CHECK (commission_value >= 0)
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_commission_rules_scope ON commission_rules (rule_scope);
    CREATE INDEX IF NOT EXISTS idx_commission_rules_active_priority
      ON commission_rules (is_active, priority DESC);
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_commission_rules_updated_at ON commission_rules;
    CREATE TRIGGER trg_commission_rules_updated_at
    BEFORE UPDATE ON commission_rules
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TRIGGER IF EXISTS trg_commission_rules_updated_at ON commission_rules;');
  await pgm.sql('DROP TABLE IF EXISTS commission_rules CASCADE;');
  await pgm.sql('DROP TRIGGER IF EXISTS trg_refunds_updated_at ON refunds;');
  await pgm.sql('DROP TABLE IF EXISTS refunds CASCADE;');
};
