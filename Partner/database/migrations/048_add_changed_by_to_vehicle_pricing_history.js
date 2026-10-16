'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    ALTER TABLE vehicle_pricing_history
    ADD COLUMN IF NOT EXISTS changed_by UUID REFERENCES users(id) ON DELETE SET NULL;
  `);
};

exports.down = async (pgm) => {
  await pgm.sql(`
    ALTER TABLE vehicle_pricing_history
    DROP COLUMN IF EXISTS changed_by;
  `);
};
