'use strict';

/**
 * Vehicle Migration Tests — Step 6
 *
 * These tests validate the Step 6 schema in an in-memory pg-mem database
 * so they run without a live PostgreSQL instance.
 *
 * Tests cover:
 *   1.  Vehicle migration works (table created)
 *   2.  Vehicle listing_status constraint
 *   3.  Vehicle fuel_type constraint
 *   4.  Vehicle transmission constraint
 *   5.  Invalid price rejected (negative)
 *   6.  Invalid seats rejected (zero/negative)
 *   7.  Invalid coordinates rejected
 *   8.  Invalid year rejected
 *   9.  Vehicle image relationship works
 *   10. Primary image constraint (only one per vehicle)
 *   11. Listing eligibility fields exist
 *   12. rating_avg and rating_count defaults
 *   13. Partner verification_status constraint
 *   14. registration_number is stored but only accessed internally
 */

const crypto = require('crypto');
const { newDb } = require('pg-mem');
const VehicleRepository = require('../../../src/repositories/vehicle.repository');

// Build an in-memory Postgres-compatible DB
function buildTestDb() {
  const db = newDb();

  // Simulate pgcrypto's gen_random_uuid()
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: db.public.getType('uuid'),
    implementation: () => crypto.randomUUID(),
    impure: true,
  });

  // Simulate update_updated_at_column trigger function (stub — pg-mem doesn't run triggers)
  const adapter = db.adapters.createPg();
  return adapter;
}

describe('Step 6 — Vehicle Schema Migration Tests', () => {
  let client;

  beforeAll(async () => {
    const { Client } = buildTestDb();
    client = new Client();
    await client.connect();

    // Create the pgcrypto extension stub
    await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";').catch(() => {});

    // Create the updated_at trigger function stub
    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `).catch(() => {});

    // Create users table (required for partners FK)
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        role VARCHAR(20) NOT NULL DEFAULT 'customer',
        name VARCHAR(150),
        country_code VARCHAR(8) NOT NULL DEFAULT '+91',
        phone VARCHAR(20),
        email VARCHAR(255),
        auth_provider VARCHAR(50) DEFAULT 'firebase',
        auth_id VARCHAR(128),
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT chk_users_role CHECK (role IN ('customer', 'partner', 'admin')),
        CONSTRAINT chk_users_contact_required CHECK (phone IS NOT NULL OR email IS NOT NULL)
      );
    `);

    // Partners
    await client.query(`
      CREATE TABLE IF NOT EXISTS partners (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        business_name VARCHAR(200),
        verification_status VARCHAR(20) NOT NULL DEFAULT 'pending',
        is_active BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT chk_partners_verification_status CHECK (
          verification_status IN ('pending', 'under_review', 'approved', 'rejected', 'suspended')
        ),
        CONSTRAINT uq_partners_user_id UNIQUE (user_id)
      );
    `);

    // Shops
    await client.query(`
      CREATE TABLE IF NOT EXISTS shops (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
        shop_name VARCHAR(200) NOT NULL,
        description TEXT,
        is_active BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Vehicle categories
    await client.query(`
      CREATE TABLE IF NOT EXISTS vehicle_categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(50) NOT NULL,
        slug VARCHAR(50) NOT NULL,
        description TEXT,
        is_active BOOLEAN NOT NULL DEFAULT true,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_vehicle_categories_slug UNIQUE (slug)
      );
    `);

    // Cities
    await client.query(`
      CREATE TABLE IF NOT EXISTS cities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(150) NOT NULL,
        state VARCHAR(100),
        country_code VARCHAR(5) NOT NULL DEFAULT 'IN',
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_cities_name_state_country UNIQUE (name, state, country_code)
      );
    `);

    // Vehicles
    await client.query(`
      CREATE TABLE IF NOT EXISTS vehicles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
        category_id UUID NOT NULL REFERENCES vehicle_categories(id) ON DELETE RESTRICT,
        vehicle_subtype VARCHAR(50),
        brand VARCHAR(100) NOT NULL,
        model VARCHAR(100) NOT NULL,
        vehicle_name VARCHAR(200) NOT NULL,
        year SMALLINT NOT NULL,
        fuel_type VARCHAR(20) NOT NULL,
        transmission VARCHAR(20) NOT NULL,
        engine_capacity_cc INTEGER,
        color VARCHAR(50),
        seats SMALLINT NOT NULL,
        mileage_kmpl NUMERIC(6,2),
        price_per_hour NUMERIC(12,2),
        price_per_day NUMERIC(12,2),
        price_per_week NUMERIC(12,2),
        price_per_month NUMERIC(12,2),
        security_deposit NUMERIC(12,2) NOT NULL DEFAULT 0,
        late_fee_per_hour NUMERIC(12,2) NOT NULL DEFAULT 0,
        extra_km_charge NUMERIC(12,2) NOT NULL DEFAULT 0,
        city_id UUID REFERENCES cities(id) ON DELETE SET NULL,
        pickup_address TEXT,
        latitude NUMERIC(10,7),
        longitude NUMERIC(10,7),
        registration_number VARCHAR(30),
        description TEXT,
        listing_status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
        rating_avg NUMERIC(3,2) NOT NULL DEFAULT 0,
        rating_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT chk_vehicles_listing_status CHECK (
          listing_status IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'REJECTED', 'SUSPENDED')
        ),
        CONSTRAINT chk_vehicles_fuel_type CHECK (
          fuel_type IN ('PETROL', 'DIESEL', 'ELECTRIC', 'CNG', 'HYBRID')
        ),
        CONSTRAINT chk_vehicles_transmission CHECK (
          transmission IN ('MANUAL', 'AUTOMATIC', 'SEMI_AUTOMATIC')
        ),
        CONSTRAINT chk_vehicles_year CHECK (year >= 1980 AND year <= 2030),
        CONSTRAINT chk_vehicles_seats CHECK (seats > 0 AND seats <= 50),
        CONSTRAINT chk_vehicles_price_per_day CHECK (price_per_day IS NULL OR price_per_day >= 0),
        CONSTRAINT chk_vehicles_security_deposit CHECK (security_deposit >= 0),
        CONSTRAINT chk_vehicles_late_fee CHECK (late_fee_per_hour >= 0),
        CONSTRAINT chk_vehicles_extra_km_charge CHECK (extra_km_charge >= 0),
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

    // Vehicle images
    await client.query(`
      CREATE TABLE IF NOT EXISTS vehicle_images (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
        storage_key TEXT NOT NULL,
        display_order SMALLINT NOT NULL DEFAULT 0,
        is_primary BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT chk_vehicle_images_display_order CHECK (display_order >= 0)
      );
    `);

    // Unique partial index: at most one primary image per vehicle (from migration 1726900000000)
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uidx_vehicle_images_one_primary
      ON vehicle_images (vehicle_id)
      WHERE is_primary = true;
    `);
  });

  afterAll(async () => {
    if (client) await client.end().catch(() => {});
  });

  // ── Seed helpers ─────────────────────────────────────────────────────────────

  async function seedUser(phone = '9876543210') {
    const res = await client.query(
      'INSERT INTO users (phone, role) VALUES ($1, \'partner\') RETURNING id',
      [phone],
    );
    return res.rows[0].id;
  }

  async function seedPartner(userId, status = 'approved') {
    const res = await client.query(
      `INSERT INTO partners (user_id, verification_status, is_active)
       VALUES ($1, $2, true) RETURNING id`,
      [userId, status],
    );
    return res.rows[0].id;
  }

  async function seedShop(partnerId) {
    const res = await client.query(
      'INSERT INTO shops (partner_id, shop_name, is_active) VALUES ($1, \'Test Shop\', true) RETURNING id',
      [partnerId],
    );
    return res.rows[0].id;
  }

  async function seedCategory() {
    const res = await client.query(
      'INSERT INTO vehicle_categories (name, slug, sort_order) VALUES (\'Bike\', \'bike\', 1) RETURNING id',
    );
    return res.rows[0].id;
  }

  async function seedVehicle(shopId, categoryId, overrides = {}) {
    const defaults = {
      shop_id: shopId,
      category_id: categoryId,
      brand: 'Honda',
      model: 'Activa',
      vehicle_name: 'Honda Activa 6G',
      year: 2022,
      fuel_type: 'PETROL',
      transmission: 'AUTOMATIC',
      seats: 2,
      listing_status: 'ACTIVE',
    };
    const merged = { ...defaults, ...overrides };
    const res = await client.query(
      `INSERT INTO vehicles (shop_id, category_id, brand, model, vehicle_name, year, fuel_type, transmission, seats, listing_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        merged.shop_id, merged.category_id, merged.brand, merged.model,
        merged.vehicle_name, merged.year, merged.fuel_type, merged.transmission,
        merged.seats, merged.listing_status,
      ],
    );
    return res.rows[0].id;
  }

  // ── Test 1: Table created ────────────────────────────────────────────────────

  it('1. vehicles table exists and accepts a valid vehicle', async () => {
    const userId = await seedUser('9000000001');
    const partnerId = await seedPartner(userId);
    const shopId = await seedShop(partnerId);
    const catId = await seedCategory();
    const vehicleId = await seedVehicle(shopId, catId);
    expect(vehicleId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  // ── Test 2: listing_status CHECK constraint ──────────────────────────────────

  it('2. invalid listing_status is rejected', async () => {
    const userId = await seedUser('9000000002');
    const partnerId = await seedPartner(userId);
    const shopId = await seedShop(partnerId);
    const catId = await client.query('SELECT id FROM vehicle_categories LIMIT 1').then((r) => r.rows[0].id);

    await expect(
      client.query(
        `INSERT INTO vehicles (shop_id, category_id, brand, model, vehicle_name, year, fuel_type, transmission, seats, listing_status)
         VALUES ($1, $2, 'Test', 'Model', 'Name', 2022, 'PETROL', 'MANUAL', 2, 'INVALID_STATUS')`,
        [shopId, catId],
      ),
    ).rejects.toThrow();
  });

  // ── Test 3: fuel_type CHECK constraint ──────────────────────────────────────

  it('3. invalid fuel_type is rejected', async () => {
    const catId = await client.query('SELECT id FROM vehicle_categories LIMIT 1').then((r) => r.rows[0].id);
    const shopId = await client.query('SELECT id FROM shops LIMIT 1').then((r) => r.rows[0].id);

    await expect(
      client.query(
        `INSERT INTO vehicles (shop_id, category_id, brand, model, vehicle_name, year, fuel_type, transmission, seats)
         VALUES ($1, $2, 'Test', 'Model', 'Name', 2022, 'COAL', 'MANUAL', 2)`,
        [shopId, catId],
      ),
    ).rejects.toThrow();
  });

  // ── Test 4: transmission CHECK constraint ────────────────────────────────────

  it('4. invalid transmission is rejected', async () => {
    const catId = await client.query('SELECT id FROM vehicle_categories LIMIT 1').then((r) => r.rows[0].id);
    const shopId = await client.query('SELECT id FROM shops LIMIT 1').then((r) => r.rows[0].id);

    await expect(
      client.query(
        `INSERT INTO vehicles (shop_id, category_id, brand, model, vehicle_name, year, fuel_type, transmission, seats)
         VALUES ($1, $2, 'Test', 'Model', 'Name', 2022, 'PETROL', 'GEAR', 2)`,
        [shopId, catId],
      ),
    ).rejects.toThrow();
  });

  // ── Test 5: Negative price rejected ─────────────────────────────────────────

  it('5. negative price_per_day is rejected', async () => {
    const catId = await client.query('SELECT id FROM vehicle_categories LIMIT 1').then((r) => r.rows[0].id);
    const shopId = await client.query('SELECT id FROM shops LIMIT 1').then((r) => r.rows[0].id);

    await expect(
      client.query(
        `INSERT INTO vehicles (shop_id, category_id, brand, model, vehicle_name, year, fuel_type, transmission, seats, price_per_day)
         VALUES ($1, $2, 'Test', 'Model', 'Name', 2022, 'PETROL', 'MANUAL', 2, -100)`,
        [shopId, catId],
      ),
    ).rejects.toThrow();
  });

  // ── Test 6: Zero/negative seats rejected ────────────────────────────────────

  it('6. zero seats is rejected', async () => {
    const catId = await client.query('SELECT id FROM vehicle_categories LIMIT 1').then((r) => r.rows[0].id);
    const shopId = await client.query('SELECT id FROM shops LIMIT 1').then((r) => r.rows[0].id);

    await expect(
      client.query(
        `INSERT INTO vehicles (shop_id, category_id, brand, model, vehicle_name, year, fuel_type, transmission, seats)
         VALUES ($1, $2, 'Test', 'Model', 'Name', 2022, 'PETROL', 'MANUAL', 0)`,
        [shopId, catId],
      ),
    ).rejects.toThrow();
  });

  // ── Test 7: Invalid coordinates rejected ─────────────────────────────────────

  it('7. latitude out of range is rejected', async () => {
    const catId = await client.query('SELECT id FROM vehicle_categories LIMIT 1').then((r) => r.rows[0].id);
    const shopId = await client.query('SELECT id FROM shops LIMIT 1').then((r) => r.rows[0].id);

    await expect(
      client.query(
        `INSERT INTO vehicles (shop_id, category_id, brand, model, vehicle_name, year, fuel_type, transmission, seats, latitude, longitude)
         VALUES ($1, $2, 'Test', 'Model', 'Name', 2022, 'PETROL', 'MANUAL', 2, 91, 77)`,
        [shopId, catId],
      ),
    ).rejects.toThrow();
  });

  it('7b. longitude out of range is rejected', async () => {
    const catId = await client.query('SELECT id FROM vehicle_categories LIMIT 1').then((r) => r.rows[0].id);
    const shopId = await client.query('SELECT id FROM shops LIMIT 1').then((r) => r.rows[0].id);

    await expect(
      client.query(
        `INSERT INTO vehicles (shop_id, category_id, brand, model, vehicle_name, year, fuel_type, transmission, seats, latitude, longitude)
         VALUES ($1, $2, 'Test', 'Model', 'Name', 2022, 'PETROL', 'MANUAL', 2, 12, 200)`,
        [shopId, catId],
      ),
    ).rejects.toThrow();
  });

  // ── Test 8: Invalid year rejected ───────────────────────────────────────────

  it('8. year before 1980 is rejected', async () => {
    const catId = await client.query('SELECT id FROM vehicle_categories LIMIT 1').then((r) => r.rows[0].id);
    const shopId = await client.query('SELECT id FROM shops LIMIT 1').then((r) => r.rows[0].id);

    await expect(
      client.query(
        `INSERT INTO vehicles (shop_id, category_id, brand, model, vehicle_name, year, fuel_type, transmission, seats)
         VALUES ($1, $2, 'Test', 'Model', 'Name', 1970, 'PETROL', 'MANUAL', 2)`,
        [shopId, catId],
      ),
    ).rejects.toThrow();
  });

  // ── Test 9: Vehicle image relationship works ─────────────────────────────────

  it('9. vehicle images can be linked to a vehicle', async () => {
    const vehicleId = await client.query('SELECT id FROM vehicles LIMIT 1').then((r) => r.rows[0].id);

    const res = await client.query(
      `INSERT INTO vehicle_images (vehicle_id, storage_key, display_order, is_primary)
       VALUES ($1, 'vehicles/test/img1.jpg', 0, true) RETURNING id`,
      [vehicleId],
    );
    expect(res.rows[0].id).toBeDefined();
  });

  // ── Test 10: Only one primary image per vehicle ──────────────────────────────

  it('10. only one primary image per vehicle is allowed', async () => {
    const vehicleId = await client.query('SELECT id FROM vehicles LIMIT 1').then((r) => r.rows[0].id);

    // Insert second primary — should fail unique constraint
    await expect(
      client.query(
        `INSERT INTO vehicle_images (vehicle_id, storage_key, display_order, is_primary)
         VALUES ($1, 'vehicles/test/img2.jpg', 1, true)`,
        [vehicleId],
      ),
    ).rejects.toThrow();
  });

  // ── Test 11: Listing eligibility fields exist ────────────────────────────────

  it('11. partners table has verification_status and is_active eligibility fields', async () => {
    const res = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'partners'
        AND column_name IN ('verification_status', 'is_active')
    `);
    const cols = res.rows.map((r) => r.column_name);
    expect(cols).toContain('verification_status');
    expect(cols).toContain('is_active');
  });

  // ── Test 12: Rating defaults ─────────────────────────────────────────────────

  it('12. rating_avg and rating_count default to 0', async () => {
    const res = await client.query('SELECT rating_avg, rating_count FROM vehicles LIMIT 1');
    expect(Number(res.rows[0].rating_avg)).toBe(0);
    expect(Number(res.rows[0].rating_count)).toBe(0);
  });

  // ── Test 13: Partner verification_status constraint ──────────────────────────

  it('13. invalid partner verification_status is rejected', async () => {
    const userId = await seedUser('9000000099');
    await expect(
      client.query(
        'INSERT INTO partners (user_id, verification_status) VALUES ($1, \'hacked\')',
        [userId],
      ),
    ).rejects.toThrow();
  });

  // ── Test 14: registration_number stored privately ───────────────────────────

  it('14. registration_number column exists but is not in public SELECT columns', async () => {
    // Verify registration_number column exists in schema
    const res = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'vehicles' AND column_name = 'registration_number'
    `);
    expect(res.rows.length).toBe(1);
    // The repository's summarySelect() should never include registration_number
    const selectStr = VehicleRepository.summarySelect();
    expect(selectStr).not.toContain('registration_number');
  });
});
