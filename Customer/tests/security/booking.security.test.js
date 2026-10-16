'use strict';

const { createDateShifter } = require('../helpers/relativeDates');

// Rental fixtures are written as readable calendar literals, but relDate() shifts them all
// by the same whole number of weeks so the earliest one always lands 14-20 days after today.
// Time-of-day, weekday and spacing between fixtures (durations, overlaps, grace periods)
// are unchanged, so prices and availability semantics are identical whenever the suite runs.
const relDate = createDateShifter('2026-12-10');

const request = require('supertest');
const { newDb, DataType } = require('pg-mem');
const crypto = require('crypto');

const { pool } = require('../../src/config/database');
const { setMockFirebaseAuth } = require('../../src/config/firebase');
const { createApp } = require('../../src/app');

const usersMigration = require('../../database/migrations/1726300000000_create-users-table');
const partnersShopsMigration = require('../../database/migrations/1726600000000_create-partners-shops-table');
const categoriesCitiesMigration = require('../../database/migrations/1726700000000_create-categories-cities-table');
const vehiclesMigration = require('../../database/migrations/1726800000000_create-vehicles-table');
const vehicleImagesMigration = require('../../database/migrations/1726900000000_create-vehicle-images-table');
const bookingsMigration = require('../../database/migrations/1727000000000_create-bookings-table');
const idempotencyMigration = require('../../database/migrations/1727100000000_create-idempotency-keys-table');
const couponsMigration = require('../../database/migrations/1727200000000_create-coupons-table');
const addCouponColumnsMigration = require('../../database/migrations/1727300000000_add-coupon-columns-to-bookings');

describe('Booking Security & Concurrency Tests — Phase 8', () => {
  let app;
  let db;
  let mockPool;

  const customer1 = {
    id: '12121212-1212-4212-8212-121212121212',
    role: 'customer',
    name: 'Customer One',
    countryCode: '+91',
    phone: '9880000001',
    email: 'c1@example.com',
    authId: 'uid-c1',
  };

  const customer2 = {
    id: '34343434-3434-4434-8434-343434343434',
    role: 'customer',
    name: 'Customer Two',
    countryCode: '+91',
    phone: '9880000002',
    email: 'c2@example.com',
    authId: 'uid-c2',
  };

  const partnerUser = {
    id: '56565656-5656-4656-8656-565656565656',
    role: 'partner',
    name: 'Partner User',
    countryCode: '+91',
    phone: '9880000003',
    email: 'p@example.com',
    authId: 'uid-p',
  };

  const partnerId = '78787878-7878-4787-8787-787878787878';
  const shopId = '90909090-9090-4090-8090-909090909090';
  const categoryId = 'abababab-abab-4bab-8bab-abababababab';
  const vehicleId = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';

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
          !statement.includes('LANGUAGE plpgsql')
          && !statement.includes('TRIGGER')
          && !statement.includes('btree_gist')
          && !statement.includes('EXCLUDE')
          && !statement.includes('DO $$')
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
    await idempotencyMigration.up(pgm);
    await couponsMigration.up(pgm);
    await addCouponColumnsMigration.up(pgm);

    const mockFirebaseAuth = {
      verifyIdToken: jest.fn().mockImplementation(async (token) => {
        if (token === 'token-c1') {
          return { uid: customer1.authId, auth_time: Math.floor(Date.now() / 1000), role: 'customer' };
        }
        if (token === 'token-c2') {
          return { uid: customer2.authId, auth_time: Math.floor(Date.now() / 1000), role: 'customer' };
        }
        if (token === 'token-partner') {
          return { uid: partnerUser.authId, auth_time: Math.floor(Date.now() / 1000), role: 'partner' };
        }
        const err = new Error('Invalid token');
        err.code = 'auth/argument-error';
        throw err;
      }),
    };
    setMockFirebaseAuth(mockFirebaseAuth);

    db.public.none(`
      INSERT INTO users (id, role, name, country_code, phone, email, auth_provider, auth_id, is_active)
      VALUES
        ('${customer1.id}', 'customer', '${customer1.name}', '+91', '${customer1.phone}', '${customer1.email}', 'firebase', '${customer1.authId}', true),
        ('${customer2.id}', 'customer', '${customer2.name}', '+91', '${customer2.phone}', '${customer2.email}', 'firebase', '${customer2.authId}', true),
        ('${partnerUser.id}', 'partner', '${partnerUser.name}', '+91', '${partnerUser.phone}', '${partnerUser.email}', 'firebase', '${partnerUser.authId}', true)
    `);

    db.public.none(`
      INSERT INTO partners (id, user_id, business_name, verification_status, is_active)
      VALUES ('${partnerId}', '${partnerUser.id}', 'Security Test Rentals', 'approved', true)
    `);

    db.public.none(`
      INSERT INTO shops (id, partner_id, shop_name, is_active)
      VALUES ('${shopId}', '${partnerId}', 'Security Shop', true)
    `);

    db.public.none(`
      INSERT INTO vehicle_categories (id, name, slug)
      VALUES ('${categoryId}', 'Car', 'car-booking-security')
    `);

    db.public.none(`
      INSERT INTO vehicles (
        id, shop_id, category_id, brand, model, vehicle_name,
        year, fuel_type, transmission, seats, price_per_day,
        security_deposit, listing_status, registration_number
      ) VALUES (
        '${vehicleId}', '${shopId}', '${categoryId}', 'Maruti', 'Swift',
        'Maruti Suzuki Swift', 2023, 'PETROL', 'MANUAL', 5, 1200.00,
        3000.00, 'ACTIVE', 'KA-01-AB-1234'
      )
    `);

    const adapter = db.adapters.createPg();
    mockPool = new adapter.Pool();
    pool.query = mockPool.query.bind(mockPool);
    pool.connect = mockPool.connect.bind(mockPool);

    app = createApp();
  });

  // ── Concurrency & Double Booking ───────────────────────────────────────────
  describe('Double-Booking Prevention & Concurrency', () => {
    it('37. two concurrent booking requests for overlapping interval: exactly one succeeds', async () => {
      const window = {
        vehicleId,
        rentalType: 'DAILY',
        startAt: relDate('2026-12-10T10:00:00Z'),
        endAt: relDate('2026-12-12T10:00:00Z'),
      };

      const [res1, res2] = await Promise.all([
        request(app)
          .post('/api/v1/bookings')
          .set('Authorization', 'Bearer token-c1')
          .send(window),
        request(app)
          .post('/api/v1/bookings')
          .set('Authorization', 'Bearer token-c2')
          .send(window),
      ]);

      const statuses = [res1.status, res2.status];
      expect(statuses).toContain(201);
      expect(statuses).toContain(409);

      const conflictRes = res1.status === 409 ? res1 : res2;
      expect(conflictRes.body.code).toBe('BOOKING_VEHICLE_UNAVAILABLE');
    });

    it('38. database remains consistent after concurrent race (exactly 1 booking committed)', () => {
      const rows = db.public.many(`
        SELECT id, customer_id, status FROM bookings
        WHERE vehicle_id = '${vehicleId}' AND start_at = '${relDate('2026-12-10T10:00:00Z')}'
      `);
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe('PENDING');
    });

    it('39. concurrent non-overlapping bookings can both succeed', async () => {
      const window1 = {
        vehicleId,
        rentalType: 'DAILY',
        startAt: relDate('2026-12-20T10:00:00Z'),
        endAt: relDate('2026-12-21T10:00:00Z'),
      };
      const window2 = {
        vehicleId,
        rentalType: 'DAILY',
        startAt: relDate('2026-12-22T10:00:00Z'),
        endAt: relDate('2026-12-23T10:00:00Z'),
      };

      const [res1, res2] = await Promise.all([
        request(app)
          .post('/api/v1/bookings')
          .set('Authorization', 'Bearer token-c1')
          .send(window1),
        request(app)
          .post('/api/v1/bookings')
          .set('Authorization', 'Bearer token-c2')
          .send(window2),
      ]);

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
    });
  });

  // ── SQL Injection & Input Validation ───────────────────────────────────────
  describe('SQL Injection & Input Hardening', () => {
    it('40a. SQL injection in vehicleId path/body is rejected by UUID validator', async () => {
      const res = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', 'Bearer token-c1')
        .send({
          vehicleId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd'; DROP TABLE bookings;--",
          rentalType: 'DAILY',
          startAt: relDate('2026-12-25T10:00:00Z'),
          endAt: relDate('2026-12-26T10:00:00Z'),
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('40b. SQL injection in bookingId path parameter is rejected safely', async () => {
      const res = await request(app)
        .get("/api/v1/bookings/11111111-1111-4111-8111-111111111111' OR '1'='1")
        .set('Authorization', 'Bearer token-c1');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('40c. SQL injection in status filter is rejected', async () => {
      const res = await request(app)
        .get('/api/v1/bookings?status=PENDING%27+OR+%271%27%3D%271')
        .set('Authorization', 'Bearer token-c1');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  // ── IDOR/BOLA & Information Disclosure ─────────────────────────────────────
  describe('IDOR / BOLA & Information Disclosure', () => {
    let bookingOwnedByC2;

    beforeAll(async () => {
      const res = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', 'Bearer token-c2')
        .send({
          vehicleId,
          rentalType: 'DAILY',
          startAt: relDate('2026-12-30T10:00:00Z'),
          endAt: relDate('2026-12-31T10:00:00Z'),
        });
      bookingOwnedByC2 = res.body.data.booking;
    });

    it('41. Customer 1 cannot access Customer 2 booking (returns 404, not 403 or 500)', async () => {
      const res = await request(app)
        .get(`/api/v1/bookings/${bookingOwnedByC2.id}`)
        .set('Authorization', 'Bearer token-c1');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('BOOKING_NOT_FOUND');
    });

    it('42. Customer 1 cannot cancel Customer 2 booking', async () => {
      const res = await request(app)
        .post(`/api/v1/bookings/${bookingOwnedByC2.id}/cancel`)
        .set('Authorization', 'Bearer token-c1');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('BOOKING_NOT_FOUND');
    });

    it('43. Private vehicle data (registration_number, RC, PUC, insurance) never in booking response', async () => {
      const res = await request(app)
        .get(`/api/v1/bookings/${bookingOwnedByC2.id}`)
        .set('Authorization', 'Bearer token-c2');

      expect(res.status).toBe(200);
      const str = JSON.stringify(res.body);
      expect(str).not.toContain('KA-01-AB-1234');
      expect(str).not.toContain('registration_number');
      expect(str).not.toContain('insurance');
      expect(str).not.toContain('puc');
      expect(str).not.toContain('rc_');
    });

    it('44. Partner KYC and private data never in booking response', async () => {
      const res = await request(app)
        .get(`/api/v1/bookings/${bookingOwnedByC2.id}`)
        .set('Authorization', 'Bearer token-c2');

      expect(res.status).toBe(200);
      const str = JSON.stringify(res.body);
      expect(str).not.toContain('kyc');
      expect(str).not.toContain('verification_status');
    });

    it('45. Raw database errors never leaked in error response for malformed or unknown inputs', async () => {
      const fakeUuid = crypto.randomUUID();
      const res = await request(app)
        .get(`/api/v1/bookings/${fakeUuid}`)
        .set('Authorization', 'Bearer token-c1');

      expect(res.status).toBe(404);
      const str = JSON.stringify(res.body);
      expect(str).not.toContain('SELECT');
      expect(str).not.toContain('FROM bookings');
      expect(str).not.toContain('PostgreSQL');
    });
  });
});
