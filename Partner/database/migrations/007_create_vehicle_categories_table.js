'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS vehicle_categories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code VARCHAR(30) NOT NULL UNIQUE,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed reference categories deterministically and idempotently
  await pgm.sql(`
    INSERT INTO vehicle_categories (code, name, description)
    VALUES
      ('CAR', 'Car', 'Four-wheeler passenger vehicles'),
      ('BIKE', 'Bike', 'Two-wheeler geared motorcycles'),
      ('SCOOTER', 'Scooter', 'Two-wheeler gearless scooters')
    ON CONFLICT (code) DO NOTHING;
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_vehicle_categories_updated_at ON vehicle_categories;
    CREATE TRIGGER trg_vehicle_categories_updated_at
    BEFORE UPDATE ON vehicle_categories
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TRIGGER IF EXISTS trg_vehicle_categories_updated_at ON vehicle_categories;');
  await pgm.sql('DROP TABLE IF EXISTS vehicle_categories CASCADE;');
};
