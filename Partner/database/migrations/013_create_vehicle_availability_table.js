'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS vehicle_availability_blocks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      start_time TIMESTAMPTZ NOT NULL,
      end_time TIMESTAMPTZ NOT NULL,
      reason VARCHAR(100) NOT NULL DEFAULT 'Maintenance',
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_avail_time_range CHECK (start_time < end_time)
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicle_avail_blocks_vehicle_time
    ON vehicle_availability_blocks (vehicle_id, start_time, end_time)
    WHERE is_active = true;
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_vehicle_avail_blocks_updated_at ON vehicle_availability_blocks;
    CREATE TRIGGER trg_vehicle_avail_blocks_updated_at
    BEFORE UPDATE ON vehicle_availability_blocks
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TRIGGER IF EXISTS trg_vehicle_avail_blocks_updated_at ON vehicle_availability_blocks;');
  await pgm.sql('DROP TABLE IF EXISTS vehicle_availability_blocks CASCADE;');
};
