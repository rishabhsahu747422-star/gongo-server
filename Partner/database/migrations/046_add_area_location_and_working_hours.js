'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  // 1. Add area/locality, working hours, and location metadata columns to partners
  await pgm.sql(`
    ALTER TABLE partners
    ADD COLUMN IF NOT EXISTS area VARCHAR(200),
    ADD COLUMN IF NOT EXISTS locality VARCHAR(200),
    ADD COLUMN IF NOT EXISTS opening_time VARCHAR(20),
    ADD COLUMN IF NOT EXISTS closing_time VARCHAR(20),
    ADD COLUMN IF NOT EXISTS is_open_24_hours BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS location_accuracy NUMERIC(10, 2),
    ADD COLUMN IF NOT EXISTS location_source VARCHAR(30);
  `);

  // 2. Add area/locality, working hours, and location metadata columns to shops
  await pgm.sql(`
    ALTER TABLE shops
    ADD COLUMN IF NOT EXISTS area VARCHAR(200),
    ADD COLUMN IF NOT EXISTS locality VARCHAR(200),
    ADD COLUMN IF NOT EXISTS opening_time VARCHAR(20),
    ADD COLUMN IF NOT EXISTS closing_time VARCHAR(20),
    ADD COLUMN IF NOT EXISTS is_open_24_hours BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS location_accuracy NUMERIC(10, 2),
    ADD COLUMN IF NOT EXISTS location_source VARCHAR(30);
  `);

  // 3. Backfill area from locality where existing locality values exist
  await pgm.sql(`
    UPDATE partners
    SET area = locality
    WHERE area IS NULL AND locality IS NOT NULL;
  `);

  await pgm.sql(`
    UPDATE shops
    SET area = locality
    WHERE area IS NULL AND locality IS NOT NULL;
  `);

  // 4. Coordinate range CHECK constraints (-90..90 for latitude, -180..180 for longitude)
  await pgm.sql(`
    ALTER TABLE partners
    DROP CONSTRAINT IF EXISTS chk_partners_latitude_range,
    ADD CONSTRAINT chk_partners_latitude_range
      CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90)),
    DROP CONSTRAINT IF EXISTS chk_partners_longitude_range,
    ADD CONSTRAINT chk_partners_longitude_range
      CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180));
  `);

  await pgm.sql(`
    ALTER TABLE shops
    DROP CONSTRAINT IF EXISTS chk_shops_latitude_range,
    ADD CONSTRAINT chk_shops_latitude_range
      CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90)),
    DROP CONSTRAINT IF EXISTS chk_shops_longitude_range,
    ADD CONSTRAINT chk_shops_longitude_range
      CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180));
  `);

  // 5. Indexes for area lookups
  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_partners_area ON partners (area);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_shops_area ON shops (area);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP INDEX IF EXISTS idx_shops_area;');
  await pgm.sql('DROP INDEX IF EXISTS idx_partners_area;');

  await pgm.sql(`
    ALTER TABLE shops
    DROP CONSTRAINT IF EXISTS chk_shops_latitude_range,
    DROP CONSTRAINT IF EXISTS chk_shops_longitude_range,
    DROP COLUMN IF EXISTS area,
    DROP COLUMN IF EXISTS locality,
    DROP COLUMN IF EXISTS opening_time,
    DROP COLUMN IF EXISTS closing_time,
    DROP COLUMN IF EXISTS is_open_24_hours,
    DROP COLUMN IF EXISTS location_accuracy,
    DROP COLUMN IF EXISTS location_source;
  `);

  await pgm.sql(`
    ALTER TABLE partners
    DROP CONSTRAINT IF EXISTS chk_partners_latitude_range,
    DROP CONSTRAINT IF EXISTS chk_partners_longitude_range,
    DROP COLUMN IF EXISTS area,
    DROP COLUMN IF EXISTS locality,
    DROP COLUMN IF EXISTS opening_time,
    DROP COLUMN IF EXISTS closing_time,
    DROP COLUMN IF EXISTS is_open_24_hours,
    DROP COLUMN IF EXISTS location_accuracy,
    DROP COLUMN IF EXISTS location_source;
  `);
};
