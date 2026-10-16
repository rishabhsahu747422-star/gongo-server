'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  // 1. Enable pgcrypto for UUID generation
  await pgm.sql('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');

  // 2. Create updated_at trigger function
  await pgm.sql(`
    CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = CURRENT_TIMESTAMP;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP FUNCTION IF EXISTS update_updated_at_column;');
};
