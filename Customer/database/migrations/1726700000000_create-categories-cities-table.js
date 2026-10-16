'use strict';

/**
 * Migration: Normalized category and city/location lookup tables.
 *
 * DESIGN DECISIONS:
 *
 * Categories:
 *   - Top-level categories are BIKE and CAR (as per business context).
 *   - Vehicle subtypes (Scooter, EV, etc.) are NOT separate top-level
 *     categories. They are modeled via fuel_type (ELECTRIC) and a
 *     vehicle_subtype field on the vehicles table for further filtering.
 *   - 'Scooter' is a subtype within the BIKE category.
 *   - 'EV' is modelled via fuel_type = 'ELECTRIC' across both categories.
 *   - This avoids contradictory category semantics.
 *
 * Cities:
 *   - Normalized: vehicles reference cities by city_id, avoiding string
 *     duplication and enabling clean city-based filtering.
 *   - state + country provide additional geographic context.
 */

exports.shorthands = undefined;

exports.up = async (pgm) => {
  // ── 1. Vehicle categories ───────────────────────────────────────
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS vehicle_categories (
      id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      name        VARCHAR(50) NOT NULL,
      slug        VARCHAR(50) NOT NULL,
      description TEXT,
      is_active   BOOLEAN     NOT NULL DEFAULT true,
      sort_order  INTEGER     NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_vehicle_categories_slug UNIQUE (slug)
    );
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicle_categories_slug
    ON vehicle_categories (slug);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicle_categories_is_active
    ON vehicle_categories (is_active);
  `);

  // Seed the two core categories
  pgm.sql(`
    INSERT INTO vehicle_categories (name, slug, description, sort_order)
    VALUES
      ('Bike', 'bike', 'Two-wheeler motorcycles, scooters, and mopeds', 1),
      ('Car',  'car',  'Four-wheeler cars, SUVs, and hatchbacks', 2)
    ON CONFLICT (slug) DO NOTHING;
  `);

  // ── 2. Cities lookup ───────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS cities (
      id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      name         VARCHAR(150) NOT NULL,
      state        VARCHAR(100),
      country_code VARCHAR(5)  NOT NULL DEFAULT 'IN',
      is_active    BOOLEAN     NOT NULL DEFAULT true,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_cities_name_state_country UNIQUE (name, state, country_code)
    );
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_cities_name
    ON cities (LOWER(name));
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_cities_is_active
    ON cities (is_active);
  `);
};

exports.down = async (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS cities CASCADE;');
  pgm.sql('DROP TABLE IF EXISTS vehicle_categories CASCADE;');
};
