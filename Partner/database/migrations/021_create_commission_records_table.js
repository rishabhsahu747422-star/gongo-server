'use strict';

/**
 * Migration: Create confidential internal commission records.
 *
 * CRITICAL BUSINESS & SECURITY RULE:
 *   GONGO internal commission is confidential company financial data.
 *   This table is strictly internal to company operations and must NEVER
 *   be exposed through customer-facing or partner-facing APIs/DTOs.
 *   The commission rate is fully configurable and must not be hardcoded.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS commission_records (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
      partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
      commission_type VARCHAR(30) NOT NULL DEFAULT 'PERCENTAGE',
      commission_rate NUMERIC(5,4) NOT NULL,
      commission_amount NUMERIC(12,2) NOT NULL,
      gross_booking_amount NUMERIC(12,2) NOT NULL,
      partner_payable_amount NUMERIC(12,2) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_commission_records_booking_id UNIQUE (booking_id),
      CONSTRAINT chk_commission_rate CHECK (commission_rate >= 0.0000 AND commission_rate <= 1.0000),
      CONSTRAINT chk_commission_amount CHECK (commission_amount >= 0.00),
      CONSTRAINT chk_commission_gross CHECK (gross_booking_amount >= 0.00),
      CONSTRAINT chk_commission_partner_payable CHECK (partner_payable_amount >= 0.00),
      CONSTRAINT chk_commission_status CHECK (status IN ('PENDING', 'CALCULATED', 'SETTLED', 'WAIVED'))
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_commission_records_booking_id
    ON commission_records (booking_id);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_commission_records_partner_id
    ON commission_records (partner_id);
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_commission_records_updated_at ON commission_records;
    CREATE TRIGGER trg_commission_records_updated_at
    BEFORE UPDATE ON commission_records
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TRIGGER IF EXISTS trg_commission_records_updated_at ON commission_records;');
  await pgm.sql('DROP TABLE IF EXISTS commission_records CASCADE;');
};
