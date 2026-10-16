'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    ALTER TABLE shops
    ADD COLUMN IF NOT EXISTS landmark VARCHAR(200);
  `);

  await pgm.sql(`
    ALTER TABLE partners
    ADD COLUMN IF NOT EXISTS landmark VARCHAR(200);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_shops_landmark
    ON shops (landmark);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP INDEX IF EXISTS idx_shops_landmark;');
  await pgm.sql('ALTER TABLE shops DROP COLUMN IF EXISTS landmark;');
  await pgm.sql('ALTER TABLE partners DROP COLUMN IF EXISTS landmark;');
};
