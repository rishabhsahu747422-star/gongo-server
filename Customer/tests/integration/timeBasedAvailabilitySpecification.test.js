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

describe('Time-Based Vehicle Availability Specification Tests (Cases A - G)', () => {
  let app;
  let db;
  let mockPool;

  const customerId = '11111111-1111-4111-8111-111111111111';
  const partnerUserId = '22222222-2222-4222-8222-222222222222';
  const partnerId = '33333333-3333-4333-8333-333333333333';
  const shopId = '44444444-4444-4444-8444-444444444444';

  const vehicleAId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const vehicleBId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const vehicleAdminOfflineId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  let categoryId;

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
    await bookingsMigration.up(pgm);

    // Ensure compatibility columns for partner operations
    try {
      db.public.none('ALTER TABLE bookings ADD COLUMN booking_status VARCHAR(50);');
      db.public.none('ALTER TABLE bookings ADD COLUMN booking_number VARCHAR(100);');
    } catch {}

    // Seed test users
    db.public.none(`
      INSERT INTO users (id, role, name, country_code, phone, email, is_active)
      VALUES
        ('${customerId}', 'customer', 'Customer Test', '+91', '9876543210', 'customer@example.com', true),
        ('${partnerUserId}', 'partner', 'Partner Test', '+91', '9876543211', 'partner@example.com', true)
    `);

    // Seed partner and shop
    db.public.none(`
      INSERT INTO partners (id, user_id, business_name, verification_status, is_active)
      VALUES ('${partnerId}', '${partnerUserId}', 'Gongo Rentals', 'approved', true)
    `);

    db.public.none(`
      INSERT INTO shops (id, partner_id, shop_name, is_active)
      VALUES ('${shopId}', '${partnerId}', 'Hub Alpha', true)
    `);

    const catRow = db.public.one(`SELECT id FROM vehicle_categories WHERE slug = 'bike'`);
    categoryId = catRow.id;

    // Seed Vehicles
    db.public.none(`
      INSERT INTO vehicles (
        id, shop_id, category_id, brand, model, vehicle_name,
        year, fuel_type, transmission, seats, price_per_hour, price_per_day,
        listing_status, pickup_address
      ) VALUES
        ('${vehicleAId}', '${shopId}', '${categoryId}', 'Royal Enfield', 'Hunter 350',
         'Hunter 350 A', 2023, 'PETROL', 'MANUAL', 2, 60.00, 500.00,
         'ACTIVE', 'City Center Hub'),
        ('${vehicleBId}', '${shopId}', '${categoryId}', 'Honda', 'Activa 6G',
         'Activa 6G B', 2023, 'PETROL', 'AUTOMATIC', 2, 40.00, 350.00,
         'ACTIVE', 'City Center Hub'),
        ('${vehicleAdminOfflineId}', '${shopId}', '${categoryId}', 'Yamaha', 'Aerox 155',
         'Aerox Suspended', 2023, 'PETROL', 'AUTOMATIC', 2, 50.00, 450.00,
         'SUSPENDED', 'City Center Hub')
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

  afterEach(() => {
    // Clear bookings after each test case to maintain test isolation
    db.public.none('DELETE FROM bookings');
  });

  describe('CASE A: 1-hour grace period enforcement and availability calculation', () => {
    beforeEach(() => {
      // Existing booking on Vehicle A: 1:00 AM to 5:00 AM UTC (grace period ends at 6:00 AM UTC)
      db.public.none(`
        INSERT INTO bookings (
          id, customer_id, vehicle_id, status, rental_type,
          start_at, end_at, base_amount, security_deposit, total_amount
        ) VALUES (
          'a0000000-0000-4000-8000-000000000001', '${customerId}', '${vehicleAId}', 'confirmed', 'HOURLY',
          '2026-10-25T01:00:00Z', '2026-10-25T05:00:00Z', 240.00, 2000.00, 2240.00
        )
      `);
    });

    it('Search for 2:00 AM to 4:00 AM -> Vehicle A unavailable', async () => {
      const res = await request(app)
        .get('/api/v1/vehicles')
        .query({
          startAt: '2026-10-25T02:00:00Z',
          endAt: '2026-10-25T04:00:00Z',
        });

      expect(res.status).toBe(200);
      const vehicleIds = res.body.data.vehicles.map((v) => v.id);
      expect(vehicleIds).not.toContain(vehicleAId);
      expect(vehicleIds).toContain(vehicleBId);
    });

    it('Search for 5:30 AM to 7:00 AM -> Vehicle A unavailable because interval overlaps grace period', async () => {
      const res = await request(app)
        .get('/api/v1/vehicles')
        .query({
          startAt: '2026-10-25T05:30:00Z',
          endAt: '2026-10-25T07:00:00Z',
        });

      expect(res.status).toBe(200);
      const vehicleIds = res.body.data.vehicles.map((v) => v.id);
      expect(vehicleIds).not.toContain(vehicleAId);
      expect(vehicleIds).toContain(vehicleBId);
    });

    it('Search for 6:00 AM to 8:00 AM -> Vehicle A is available at and after grace period boundary', async () => {
      const res = await request(app)
        .get('/api/v1/vehicles')
        .query({
          startAt: '2026-10-25T06:00:00Z',
          endAt: '2026-10-25T08:00:00Z',
        });

      expect(res.status).toBe(200);
      const vehicleIds = res.body.data.vehicles.map((v) => v.id);
      expect(vehicleIds).toContain(vehicleAId);
      expect(vehicleIds).toContain(vehicleBId);
    });
  });

  describe('CASE B: Non-overlapping future search is not hidden merely because earlier booking exists', () => {
    it('Search for 7:00 AM to 9:00 AM is available when earlier booking was 1:00 AM to 5:00 AM', async () => {
      db.public.none(`
        INSERT INTO bookings (
          id, customer_id, vehicle_id, status, rental_type,
          start_at, end_at, base_amount, security_deposit, total_amount
        ) VALUES (
          'b0000000-0000-4000-8000-000000000001', '${customerId}', '${vehicleAId}', 'confirmed', 'HOURLY',
          '2026-10-25T01:00:00Z', '2026-10-25T05:00:00Z', 240.00, 2000.00, 2240.00
        )
      `);

      const res = await request(app)
        .get('/api/v1/vehicles')
        .query({
          startAt: '2026-10-25T07:00:00Z',
          endAt: '2026-10-25T09:00:00Z',
        });

      expect(res.status).toBe(200);
      const vehicleIds = res.body.data.vehicles.map((v) => v.id);
      expect(vehicleIds).toContain(vehicleAId);
    });
  });

  describe('CASE C: Atomic backend prevention of overlapping double bookings', () => {
    it('Backend repository rejects booking creation when interval conflicts with existing booking grace period', async () => {
      const BookingRepository = require('../../src/repositories/booking.repository');
      const bookingRepository = new BookingRepository();

      // Insert existing booking: 1:00 AM to 5:00 AM
      db.public.none(`
        INSERT INTO bookings (
          id, customer_id, vehicle_id, status, rental_type,
          start_at, end_at, base_amount, security_deposit, total_amount
        ) VALUES (
          'c0000000-0000-4000-8000-000000000001', '${customerId}', '${vehicleAId}', 'confirmed', 'HOURLY',
          '2026-10-25T01:00:00Z', '2026-10-25T05:00:00Z', 240.00, 2000.00, 2240.00
        )
      `);

      // Overlapping attempt inside grace period: 5:15 AM to 8:00 AM
      const conflict = await bookingRepository.findOverlappingBooking(
        vehicleAId,
        '2026-10-25T05:15:00Z',
        '2026-10-25T08:00:00Z'
      );
      expect(conflict).not.toBeNull();
      expect(conflict.id).toBe('c0000000-0000-4000-8000-000000000001');

      // Non-overlapping attempt: 6:00 AM to 8:00 AM
      const noConflict = await bookingRepository.findOverlappingBooking(
        vehicleAId,
        '2026-10-25T06:00:00Z',
        '2026-10-25T08:00:00Z'
      );
      expect(noConflict).toBeNull();
    });
  });

  describe('CASE D: Cancelled bookings do not block availability', () => {
    it('Cancelled booking releases the time interval for search and booking', async () => {
      db.public.none(`
        INSERT INTO bookings (
          id, customer_id, vehicle_id, status, rental_type,
          start_at, end_at, base_amount, security_deposit, total_amount
        ) VALUES (
          'd0000000-0000-4000-8000-000000000001', '${customerId}', '${vehicleAId}', 'cancelled', 'HOURLY',
          '2026-10-25T01:00:00Z', '2026-10-25T05:00:00Z', 240.00, 2000.00, 2240.00
        )
      `);

      const res = await request(app)
        .get('/api/v1/vehicles')
        .query({
          startAt: '2026-10-25T02:00:00Z',
          endAt: '2026-10-25T04:00:00Z',
        });

      expect(res.status).toBe(200);
      const vehicleIds = res.body.data.vehicles.map((v) => v.id);
      expect(vehicleIds).toContain(vehicleAId);
    });
  });

  describe('CASE E: Physical return check prevents unsafe handover during ongoing rental', () => {
    it('Partner findConflictingActiveBooking blocks handover if previous rental has not returned', async () => {
      const partnerBookingRepo = require('../../../Partner/src/repositories/booking.repository');

      // Vehicle A has an ACTIVE / IN_PROGRESS rental that has not been returned
      db.public.none(`
        INSERT INTO bookings (
          id, customer_id, vehicle_id, status, booking_status, rental_type,
          start_at, end_at, base_amount, security_deposit, total_amount
        ) VALUES (
          'e0000000-0000-4000-8000-000000000001', '${customerId}', '${vehicleAId}', 'in_progress', 'ACTIVE', 'HOURLY',
          '2026-10-25T01:00:00Z', '2026-10-25T05:00:00Z', 240.00, 2000.00, 2240.00
        )
      `);

      // Subsequent booking id for vehicle A
      const nextBookingId = 'e0000000-0000-4000-8000-000000000002';

      const conflictingActive = await partnerBookingRepo.findConflictingActiveBooking(
        vehicleAId,
        nextBookingId,
        mockPool
      );

      expect(conflictingActive).not.toBeNull();
      expect(conflictingActive.id).toBe('e0000000-0000-4000-8000-000000000001');
    });
  });

  describe('CASE F: Multiple bookings on the same day evaluated independently', () => {
    beforeEach(() => {
      // Booking 1: 01:00 AM - 04:00 AM (grace period to 05:00 AM)
      // Booking 2: 07:00 AM - 10:00 AM (grace period to 11:00 AM)
      db.public.none(`
        INSERT INTO bookings (
          id, customer_id, vehicle_id, status, rental_type,
          start_at, end_at, base_amount, security_deposit, total_amount
        ) VALUES
          ('f0000000-0000-4000-8000-000000000001', '${customerId}', '${vehicleAId}', 'confirmed', 'HOURLY',
           '2026-10-26T01:00:00Z', '2026-10-26T04:00:00Z', 180.00, 2000.00, 2180.00),
          ('f0000000-0000-4000-8000-000000000002', '${customerId}', '${vehicleAId}', 'confirmed', 'HOURLY',
           '2026-10-26T07:00:00Z', '2026-10-26T10:00:00Z', 180.00, 2000.00, 2180.00)
      `);
    });

    it('Search in Booking 1 (02:00 to 03:00) -> Unavailable', async () => {
      const res = await request(app)
        .get('/api/v1/vehicles')
        .query({
          startAt: '2026-10-26T02:00:00Z',
          endAt: '2026-10-26T03:00:00Z',
        });
      const vehicleIds = res.body.data.vehicles.map((v) => v.id);
      expect(vehicleIds).not.toContain(vehicleAId);
    });

    it('Search in Booking 1 grace period (04:30 to 05:30) -> Unavailable', async () => {
      const res = await request(app)
        .get('/api/v1/vehicles')
        .query({
          startAt: '2026-10-26T04:30:00Z',
          endAt: '2026-10-26T05:30:00Z',
        });
      const vehicleIds = res.body.data.vehicles.map((v) => v.id);
      expect(vehicleIds).not.toContain(vehicleAId);
    });

    it('Search in gap between bookings (05:00 to 06:30) -> Available', async () => {
      const res = await request(app)
        .get('/api/v1/vehicles')
        .query({
          startAt: '2026-10-26T05:00:00Z',
          endAt: '2026-10-26T06:30:00Z',
        });
      const vehicleIds = res.body.data.vehicles.map((v) => v.id);
      expect(vehicleIds).toContain(vehicleAId);
    });

    it('Search in Booking 2 (08:00 to 09:00) -> Unavailable', async () => {
      const res = await request(app)
        .get('/api/v1/vehicles')
        .query({
          startAt: '2026-10-26T08:00:00Z',
          endAt: '2026-10-26T09:00:00Z',
        });
      const vehicleIds = res.body.data.vehicles.map((v) => v.id);
      expect(vehicleIds).not.toContain(vehicleAId);
    });

    it('Search in Booking 2 grace period (10:15 to 11:15) -> Unavailable', async () => {
      const res = await request(app)
        .get('/api/v1/vehicles')
        .query({
          startAt: '2026-10-26T10:15:00Z',
          endAt: '2026-10-26T11:15:00Z',
        });
      const vehicleIds = res.body.data.vehicles.map((v) => v.id);
      expect(vehicleIds).not.toContain(vehicleAId);
    });

    it('Search after Booking 2 grace period (11:00 to 14:00) -> Available', async () => {
      const res = await request(app)
        .get('/api/v1/vehicles')
        .query({
          startAt: '2026-10-26T11:00:00Z',
          endAt: '2026-10-26T14:00:00Z',
        });
      const vehicleIds = res.body.data.vehicles.map((v) => v.id);
      expect(vehicleIds).toContain(vehicleAId);
    });
  });

  describe('CASE G: Preservation of partner/vehicle verification and administrative visibility', () => {
    it('Admin OFFLINE vehicle is never visible even when date interval has no bookings', async () => {
      const res = await request(app)
        .get('/api/v1/vehicles')
        .query({
          startAt: '2026-10-27T10:00:00Z',
          endAt: '2026-10-27T12:00:00Z',
        });

      expect(res.status).toBe(200);
      const vehicleIds = res.body.data.vehicles.map((v) => v.id);
      expect(vehicleIds).not.toContain(vehicleAdminOfflineId);
      expect(vehicleIds).toContain(vehicleAId);
      expect(vehicleIds).toContain(vehicleBId);
    });

    it('Vehicles belonging to an unapproved partner are not returned in customer search', async () => {
      // Temporarily mark partner unapproved
      db.public.none(`UPDATE partners SET verification_status = 'pending' WHERE id = '${partnerId}'`);

      const res = await request(app)
        .get('/api/v1/vehicles')
        .query({
          startAt: '2026-10-27T10:00:00Z',
          endAt: '2026-10-27T12:00:00Z',
        });

      // Restore partner verification
      db.public.none(`UPDATE partners SET verification_status = 'approved' WHERE id = '${partnerId}'`);

      expect(res.status).toBe(200);
      expect(res.body.data.vehicles).toEqual([]);
    });
  });
});
