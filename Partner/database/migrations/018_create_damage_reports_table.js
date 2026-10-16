'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS damage_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
      vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
      reported_by UUID NOT NULL,
      damage_type VARCHAR(50) NOT NULL DEFAULT 'ACCIDENT',
      description TEXT NOT NULL,
      estimated_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
      approved_amount NUMERIC(12,2),
      status VARCHAR(30) NOT NULL DEFAULT 'REPORTED',
      photos TEXT[],
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_damage_reports_status CHECK (status IN ('REPORTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'SETTLED')),
      CONSTRAINT chk_damage_estimated_amount CHECK (estimated_amount >= 0.00),
      CONSTRAINT chk_damage_approved_amount CHECK (approved_amount IS NULL OR approved_amount >= 0.00)
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_damage_reports_booking_id
    ON damage_reports (booking_id);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_damage_reports_vehicle_id
    ON damage_reports (vehicle_id);
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_damage_reports_updated_at ON damage_reports;
    CREATE TRIGGER trg_damage_reports_updated_at
    BEFORE UPDATE ON damage_reports
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TRIGGER IF EXISTS trg_damage_reports_updated_at ON damage_reports;');
  await pgm.sql('DROP TABLE IF EXISTS damage_reports CASCADE;');
};
