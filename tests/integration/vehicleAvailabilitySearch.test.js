'use strict';

const request = require('supertest');
const { newDb, DataType } = require('pg-mem');
const crypto = require('crypto');
const { pool } = require('../../src/config/database');
const { createApp } = require('../../src/app');

// Migrations
const usersMigration = require('../../database/migrations/1726300000000_create-users-table');
const partnersShopsMigration = require('../../database/migrations/1726600000000_create-partners-shops-table');
const categoriesCitiesMigration = require('../../database/migrations/1726700000000_create-categories-cities-table');
const vehiclesMigration = require('../../database/migrations/1726800000000_create-vehicles-table');
const vehicleImagesMigration = require('../../database/migrations/1726900000000_create-vehicle-images-table');
const bookingsMigration = require('../../database/migrations/1727000000000_create-bookings-table');

describe('Customer Vehicle Availability Search Integration Tests', () => {
  let app;
  let db;
  let mockPool;

  const customerId = '11111111-1111-4111-8111-111111111111';
  const partnerUserId = '22222222-2222-4222-8222-222222222222';
  const partnerId = '33333333-3333-4333-8333-333333333333';
  const shopId = '44444444-4444-4444-8444-444444444444';
  const categoryId = '55555555-5555-4555-8555-555555555555';

  const vehicleAId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const vehicleBId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  beforeAll(async () => {
    db = newDb();
    db.registerExtension('pgcrypto', (schema) => {
      schema.registerFunction({
        name: 'gen_random_uuid',
        returns: DataType.uuid,
        impure: true,
        implementation: () => crypto.randomUUID(),
      });
    });

    const pgm = {
      sql: (statement) => {
        if (
          !statement.includes('LANGUAGE plpgsql') &&
          !statement.includes('TRIGGER') &&
          !statement.includes('btree_gist') &&
          !statement.includes('EXCLUDE') &&
          !statement.includes('DO $$')
        ) {
          db.public.none(statement);
        }
      },
    };

    await usersMigration.up(pgm);
    await partnersShopsMigration.up(pgm);
    await categoriesCitiesMigration.up(pgm);
    await vehiclesMigration.up(pgm);
    await vehicleImagesMigration.up(pgm);
    await bookingsMigration.up(pgm);

    // Seed test users
    db.public.none(`
      INSERT INTO users (id, role, name, country_code, phone, email, is_active)
      VALUES
        ('${customerId}', 'customer', 'Customer One', '+91', '9876543210', 'customer@example.com', true),
        ('${partnerUserId}', 'partner', 'Partner One', '+91', '9876543211', 'partner@example.com', true)
    `);

    // Seed partner and shop
    db.public.none(`
      INSERT INTO partners (id, user_id, business_name, verification_status, is_active)
      VALUES ('${partnerId}', '${partnerUserId}', 'Fast Wheels', 'approved', true)
    `);

    db.public.none(`
      INSERT INTO shops (id, partner_id, shop_name, is_active)
      VALUES ('${shopId}', '${partnerId}', 'Main Branch', true)
    `);

    // Query seeded category
    const catRow = db.public.one(`SELECT id FROM vehicle_categories WHERE slug = 'bike'`);
    const categoryId = catRow.id;

    // Seed Vehicles A and B
    db.public.none(`
      INSERT INTO vehicles (
        id, shop_id, category_id, brand, model, vehicle_name,
        year, fuel_type, transmission, seats, price_per_hour, price_per_day,
        listing_status, pickup_address
      ) VALUES
        ('${vehicleAId}', '${shopId}', '${categoryId}', 'Royal Enfield', 'Hunter 350',
         'Royal Enfield Hunter 350', 2023, 'PETROL', 'MANUAL', 2, 60.00, 500.00,
         'ACTIVE', 'City Center'),
        ('${vehicleBId}', '${shopId}', '${categoryId}', 'Honda', 'Activa 6G',
         'Honda Activa 6G', 2023, 'PETROL', 'AUTOMATIC', 2, 40.00, 350.00,
         'ACTIVE', 'City Center')
    `);

    // Vehicle A has an existing booking on Oct 10 from 12:00 PM to 04:00 PM UTC
    db.public.none(`
      INSERT INTO bookings (
        id, customer_id, vehicle_id, status, rental_type,
        start_at, end_at, base_amount, security_deposit, total_amount
      ) VALUES (
        '10000000-0000-4000-8000-000000000001', '${customerId}', '${vehicleAId}', 'confirmed', 'HOURLY',
        '2026-10-10T12:00:00Z', '2026-10-10T16:00:00Z', 240.00, 2000.00, 2240.00
      )
    `);

    const adapter = db.adapters.createPg();
    mockPool = new adapter.Pool();
    pool.query = mockPool.query.bind(mockPool);
    pool.connect = mockPool.connect.bind(mockPool);

    app = createApp();
  });

  afterAll(async () => {
    if (mockPool) {
      await mockPool.end();
    }
  });

  it('1. Excludes Vehicle A when customer searches overlapping time range (10 AM to 6 PM)', async () => {
    const res = await request(app)
      .get('/api/v1/vehicles')
      .query({
        startAt: '2026-10-10T10:00:00Z',
        endAt: '2026-10-10T18:00:00Z',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const vehicleIds = res.body.data.vehicles.map((v) => v.id);
    expect(vehicleIds).not.toContain(vehicleAId);
    expect(vehicleIds).toContain(vehicleBId);
  });

  it('2. Excludes Vehicle A during the 1-hour grace period (4:30 PM to 6:00 PM)', async () => {
    const res = await request(app)
      .get('/api/v1/vehicles')
      .query({
        startAt: '2026-10-10T16:30:00Z',
        endAt: '2026-10-10T18:00:00Z',
      });

    expect(res.status).toBe(200);
    const vehicleIds = res.body.data.vehicles.map((v) => v.id);
    expect(vehicleIds).not.toContain(vehicleAId);
    expect(vehicleIds).toContain(vehicleBId);
  });

  it('2b. Includes Vehicle A when customer searches adjacent boundary after grace period ends (5 PM to 8 PM)', async () => {
    const res = await request(app)
      .get('/api/v1/vehicles')
      .query({
        startAt: '2026-10-10T17:00:00Z',
        endAt: '2026-10-10T20:00:00Z',
      });

    expect(res.status).toBe(200);
    const vehicleIds = res.body.data.vehicles.map((v) => v.id);
    expect(vehicleIds).toContain(vehicleAId);
    expect(vehicleIds).toContain(vehicleBId);
  });

  it('3. Includes Vehicle A when customer searches adjacent boundary before booking (8 AM to 12 PM)', async () => {
    const res = await request(app)
      .get('/api/v1/vehicles')
      .query({
        startAt: '2026-10-10T08:00:00Z',
        endAt: '2026-10-10T12:00:00Z',
      });

    expect(res.status).toBe(200);
    const vehicleIds = res.body.data.vehicles.map((v) => v.id);
    expect(vehicleIds).toContain(vehicleAId);
    expect(vehicleIds).toContain(vehicleBId);
  });

  it('4. Cancelled booking does NOT block vehicle availability', async () => {
    // Insert a CANCELLED booking on Vehicle B from 10 AM to 2 PM
    db.public.none(`
      INSERT INTO bookings (
        id, customer_id, vehicle_id, status, rental_type,
        start_at, end_at, base_amount, security_deposit, total_amount
      ) VALUES (
        '10000000-0000-4000-8000-000000000002', '${customerId}', '${vehicleBId}', 'CANCELLED', 'HOURLY',
        '2026-10-12T10:00:00Z', '2026-10-12T14:00:00Z', 160.00, 2000.00, 2160.00
      )
    `);

    const res = await request(app)
      .get('/api/v1/vehicles')
      .query({
        startAt: '2026-10-12T11:00:00Z',
        endAt: '2026-10-12T13:00:00Z',
      });

    expect(res.status).toBe(200);
    const vehicleIds = res.body.data.vehicles.map((v) => v.id);
    expect(vehicleIds).toContain(vehicleBId);
  });

  it('5. Completed historical booking does NOT block vehicle availability', async () => {
    // Insert a COMPLETED booking on Vehicle B from 10 AM to 2 PM
    db.public.none(`
      INSERT INTO bookings (
        id, customer_id, vehicle_id, status, rental_type,
        start_at, end_at, base_amount, security_deposit, total_amount
      ) VALUES (
        '10000000-0000-4000-8000-000000000003', '${customerId}', '${vehicleBId}', 'COMPLETED', 'HOURLY',
        '2026-10-13T10:00:00Z', '2026-10-13T14:00:00Z', 160.00, 2000.00, 2160.00
      )
    `);

    const res = await request(app)
      .get('/api/v1/vehicles')
      .query({
        startAt: '2026-10-13T11:00:00Z',
        endAt: '2026-10-13T13:00:00Z',
      });

    expect(res.status).toBe(200);
    const vehicleIds = res.body.data.vehicles.map((v) => v.id);
    expect(vehicleIds).toContain(vehicleBId);
  });

  it('6. Cross-midnight booking overlap excludes vehicle', async () => {
    // Booking on Vehicle B: Oct 14 11:00 PM to Oct 15 02:00 AM (2026-10-14T23:00:00Z to 2026-10-15T02:00:00Z)
    db.public.none(`
      INSERT INTO bookings (
        id, customer_id, vehicle_id, status, rental_type,
        start_at, end_at, base_amount, security_deposit, total_amount
      ) VALUES (
        '10000000-0000-4000-8000-000000000004', '${customerId}', '${vehicleBId}', 'confirmed', 'HOURLY',
        '2026-10-14T23:00:00Z', '2026-10-15T02:00:00Z', 120.00, 2000.00, 2120.00
      )
    `);

    // Customer searches cross-midnight overlap: Oct 15 12:00 AM to 01:00 AM
    const res = await request(app)
      .get('/api/v1/vehicles')
      .query({
        startAt: '2026-10-15T00:00:00Z',
        endAt: '2026-10-15T01:00:00Z',
      });

    expect(res.status).toBe(200);
    const vehicleIds = res.body.data.vehicles.map((v) => v.id);
    expect(vehicleIds).not.toContain(vehicleBId);
  });

  it('7. Returns empty vehicle array when all vehicles have overlapping bookings', async () => {
    // Create an overlapping booking for Vehicle B as well on Oct 10 12:00 PM to 04:00 PM
    db.public.none(`
      INSERT INTO bookings (
        id, customer_id, vehicle_id, status, rental_type,
        start_at, end_at, base_amount, security_deposit, total_amount
      ) VALUES (
        '10000000-0000-4000-8000-000000000005', '${customerId}', '${vehicleBId}', 'confirmed', 'HOURLY',
        '2026-10-10T12:00:00Z', '2026-10-10T16:00:00Z', 160.00, 2000.00, 2160.00
      )
    `);

    const res = await request(app)
      .get('/api/v1/vehicles')
      .query({
        startAt: '2026-10-10T13:00:00Z',
        endAt: '2026-10-10T15:00:00Z',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.vehicles).toEqual([]);
    expect(res.body.data.pagination.total).toBe(0);
  });
});
