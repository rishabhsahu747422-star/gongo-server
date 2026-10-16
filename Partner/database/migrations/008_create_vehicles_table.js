'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS vehicles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
      shop_id UUID REFERENCES shops(id) ON DELETE SET NULL,
      category VARCHAR(30) NOT NULL,
      brand VARCHAR(100) NOT NULL,
      model VARCHAR(100) NOT NULL,
      variant VARCHAR(100),
      registration_number VARCHAR(50) NOT NULL,
      year INTEGER NOT NULL,
      fuel_type VARCHAR(20) NOT NULL,
      transmission VARCHAR(20) NOT NULL DEFAULT 'Manual',
      seats INTEGER NOT NULL DEFAULT 2,
      description TEXT,
      manual_status VARCHAR(20) NOT NULL DEFAULT 'ONLINE',
      rental_status VARCHAR(20) NOT NULL DEFAULT 'IDLE',
      verification_status VARCHAR(30) NOT NULL DEFAULT 'VERIFIED',
      is_archived BOOLEAN NOT NULL DEFAULT false,
      offline_reason VARCHAR(100),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_vehicles_registration UNIQUE (registration_number),
      CONSTRAINT chk_vehicles_category CHECK (category IN ('CAR', 'BIKE', 'SCOOTER', 'Car', 'Bike', 'Scooter')),
      CONSTRAINT chk_vehicles_fuel_type CHECK (fuel_type IN ('Petrol', 'Diesel', 'EV', 'CNG')),
      CONSTRAINT chk_vehicles_transmission CHECK (transmission IN ('Manual', 'Automatic')),
      CONSTRAINT chk_vehicles_manual_status CHECK (manual_status IN ('ONLINE', 'OFFLINE')),
      CONSTRAINT chk_vehicles_rental_status CHECK (rental_status IN ('IDLE', 'BOOKED', 'ACTIVE')),
      CONSTRAINT chk_vehicles_seats CHECK (seats >= 1 AND seats <= 50),
      CONSTRAINT chk_vehicles_year CHECK (year >= 1990 AND year <= 2050)
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicles_partner_id
    ON vehicles (partner_id);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicles_shop_id
    ON vehicles (shop_id);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicles_category
    ON vehicles (category);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicles_manual_status
    ON vehicles (manual_status);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicles_rental_status
    ON vehicles (rental_status);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicles_is_archived
    ON vehicles (is_archived);
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_vehicles_updated_at ON vehicles;
    CREATE TRIGGER trg_vehicles_updated_at
    BEFORE UPDATE ON vehicles
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TRIGGER IF EXISTS trg_vehicles_updated_at ON vehicles;');
  await pgm.sql('DROP TABLE IF EXISTS vehicles CASCADE;');
};
