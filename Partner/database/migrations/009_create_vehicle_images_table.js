'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS vehicle_images (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      storage_key VARCHAR(500) NOT NULL,
      image_url TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_cover BOOLEAN NOT NULL DEFAULT false,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_vehicle_images_sort_order CHECK (sort_order >= 0)
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicle_images_vehicle_id
    ON vehicle_images (vehicle_id);
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_vehicle_images_updated_at ON vehicle_images;
    CREATE TRIGGER trg_vehicle_images_updated_at
    BEFORE UPDATE ON vehicle_images
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TRIGGER IF EXISTS trg_vehicle_images_updated_at ON vehicle_images;');
  await pgm.sql('DROP TABLE IF EXISTS vehicle_images CASCADE;');
};
