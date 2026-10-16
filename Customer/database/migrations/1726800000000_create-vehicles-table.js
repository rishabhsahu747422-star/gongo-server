'use strict';

/**
 * Migration: Production vehicles table.
 *
 * SECURITY DECISIONS:
 *   - registration_number is stored privately; it is NOT exposed via any
 *     public discovery API. It is present for future booking/pickup operational
 *     flows only and will be protected by authenticated/role-gated endpoints.
 *   - No insurance, RC, PUC, or fitness certificate columns here; those belong
 *     to the Partner backend module if required.
 *
 * MONETARY TYPES:
 *   - All prices use NUMERIC(12,2) — exact decimal arithmetic, no floating-
 *     point rounding errors. This is required for financial correctness.
 *
 * AVAILABILITY DESIGN:
 *   - `listing_status` controls static listing eligibility:
 *       ACTIVE  = visible to customers
 *       DRAFT   = not yet published
 *       INACTIVE = temporarily unlisted by partner
 *       REJECTED = failed partner review
 *       SUSPENDED = admin-suspended
 *   - Dynamic booking-based availability (checking active bookings for a
 *     date range) is intentionally deferred to the Booking module (Step 7+).
 *     The service layer architecture separates static eligibility from dynamic
 *     availability so booking-based checking can be integrated without
 *     refactoring the discovery queries.
 *
 * GEOGRAPHIC INDEXING:
 *   - latitude + longitude are stored as NUMERIC(10,7) for precision.
 *   - A functional index on the bounding box (CAST lat/lon to FLOAT8) supports
 *     efficient nearby queries using a bounding-box pre-filter followed by
 *     Haversine distance calculation in the application layer.
 *   - If PostGIS is introduced in a later step, these columns can be used to
 *     populate a geography column without schema changes.
 *
 * RATING SUMMARY:
 *   - rating_avg and rating_count are denormalized summary columns.
 *   - They will be updated by the Reviews module (future step) via triggers
 *     or background jobs. Discovery queries use them for rating-based sorting.
 *
 * VEHICLE SUBTYPE:
 *   - vehicle_subtype allows partners to specify 'scooter', 'motorcycle',
 *     'moped' within BIKE, or 'hatchback', 'suv', 'sedan' within CAR.
 *   - Customer filter for 'Scooter' maps to: category=bike AND
 *     vehicle_subtype='scooter'. No contradictory category semantics.
 */

exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS vehicles (
      -- Identity
      id                    UUID           PRIMARY KEY DEFAULT gen_random_uuid(),

      -- Ownership chain (enforces: users → partners → shops → vehicles)
      shop_id               UUID           NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,

      -- Classification
      category_id           UUID           NOT NULL REFERENCES vehicle_categories(id) ON DELETE RESTRICT,
      vehicle_subtype       VARCHAR(50),

      -- Vehicle information
      brand                 VARCHAR(100)   NOT NULL,
      model                 VARCHAR(100)   NOT NULL,
      vehicle_name          VARCHAR(200)   NOT NULL,
      year                  SMALLINT       NOT NULL,
      fuel_type             VARCHAR(20)    NOT NULL,
      transmission          VARCHAR(20)    NOT NULL,
      engine_capacity_cc    INTEGER,
      color                 VARCHAR(50),
      seats                 SMALLINT       NOT NULL,
      mileage_kmpl          NUMERIC(6,2),

      -- Pricing (NUMERIC — never float for money)
      price_per_hour        NUMERIC(12,2),
      price_per_day         NUMERIC(12,2),
      price_per_week        NUMERIC(12,2),
      price_per_month       NUMERIC(12,2),
      security_deposit      NUMERIC(12,2)  NOT NULL DEFAULT 0,
      late_fee_per_hour     NUMERIC(12,2)  NOT NULL DEFAULT 0,
      extra_km_charge       NUMERIC(12,2)  NOT NULL DEFAULT 0,

      -- Pickup location (city + address + coordinates)
      city_id               UUID           REFERENCES cities(id) ON DELETE SET NULL,
      pickup_address        TEXT,
      latitude              NUMERIC(10,7),
      longitude             NUMERIC(10,7),

      -- Private operational data (NOT exposed via public APIs)
      registration_number   VARCHAR(30),

      -- Content
      description           TEXT,

      -- Listing status
      listing_status        VARCHAR(20)    NOT NULL DEFAULT 'DRAFT',

      -- Rating summary (denormalized; updated by Reviews module)
      rating_avg            NUMERIC(3,2)   NOT NULL DEFAULT 0,
      rating_count          INTEGER        NOT NULL DEFAULT 0,

      -- Timestamps
      created_at            TIMESTAMPTZ    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at            TIMESTAMPTZ    NOT NULL DEFAULT CURRENT_TIMESTAMP,

      -- ── CONSTRAINTS ────────────────────────────────────────────
      CONSTRAINT chk_vehicles_listing_status CHECK (
        listing_status IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'REJECTED', 'SUSPENDED')
      ),
      CONSTRAINT chk_vehicles_fuel_type CHECK (
        fuel_type IN ('PETROL', 'DIESEL', 'ELECTRIC', 'CNG', 'HYBRID')
      ),
      CONSTRAINT chk_vehicles_transmission CHECK (
        transmission IN ('MANUAL', 'AUTOMATIC', 'SEMI_AUTOMATIC')
      ),
      CONSTRAINT chk_vehicles_year CHECK (
        year >= 1980 AND year <= EXTRACT(YEAR FROM CURRENT_DATE)::SMALLINT + 2
      ),
      CONSTRAINT chk_vehicles_seats CHECK (seats > 0 AND seats <= 50),
      CONSTRAINT chk_vehicles_price_per_hour  CHECK (price_per_hour  IS NULL OR price_per_hour  >= 0),
      CONSTRAINT chk_vehicles_price_per_day   CHECK (price_per_day   IS NULL OR price_per_day   >= 0),
      CONSTRAINT chk_vehicles_price_per_week  CHECK (price_per_week  IS NULL OR price_per_week  >= 0),
      CONSTRAINT chk_vehicles_price_per_month CHECK (price_per_month IS NULL OR price_per_month >= 0),
      CONSTRAINT chk_vehicles_security_deposit CHECK (security_deposit >= 0),
      CONSTRAINT chk_vehicles_late_fee        CHECK (late_fee_per_hour >= 0),
      CONSTRAINT chk_vehicles_extra_km_charge CHECK (extra_km_charge >= 0),
      CONSTRAINT chk_vehicles_mileage         CHECK (mileage_kmpl IS NULL OR mileage_kmpl >= 0),
      CONSTRAINT chk_vehicles_engine_capacity CHECK (engine_capacity_cc IS NULL OR engine_capacity_cc > 0),
      CONSTRAINT chk_vehicles_latitude CHECK (
        latitude IS NULL OR (latitude >= -90 AND latitude <= 90)
      ),
      CONSTRAINT chk_vehicles_longitude CHECK (
        longitude IS NULL OR (longitude >= -180 AND longitude <= 180)
      ),
      CONSTRAINT chk_vehicles_rating_avg CHECK (rating_avg >= 0 AND rating_avg <= 5),
      CONSTRAINT chk_vehicles_rating_count CHECK (rating_count >= 0)
    );
  `);

  // ── Discovery query indexes ─────────────────────────────────────
  // Composite index for the primary eligibility filter used in ALL discovery queries
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicles_listing_status
    ON vehicles (listing_status);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicles_shop_id
    ON vehicles (shop_id);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicles_category_id
    ON vehicles (category_id);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicles_brand
    ON vehicles (LOWER(brand));
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicles_fuel_type
    ON vehicles (fuel_type);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicles_transmission
    ON vehicles (transmission);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicles_city_id
    ON vehicles (city_id);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicles_price_per_day
    ON vehicles (price_per_day);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicles_rating_avg
    ON vehicles (rating_avg);
  `);

  // Geographic bounding-box index for nearby queries
  // Casts to float8 allow efficient range scan without PostGIS
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicles_geo_lat_lon
    ON vehicles (latitude, longitude)
    WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
  `);

  // Composite eligibility + listing index for the hot discovery path
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicles_active_listing
    ON vehicles (listing_status, category_id, city_id)
    WHERE listing_status = 'ACTIVE';
  `);

  // updated_at trigger
  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_vehicles_updated_at ON vehicles;
    CREATE TRIGGER trg_vehicles_updated_at
    BEFORE UPDATE ON vehicles
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  pgm.sql('DROP TRIGGER IF EXISTS trg_vehicles_updated_at ON vehicles;');
  pgm.sql('DROP TABLE IF EXISTS vehicles CASCADE;');
};
