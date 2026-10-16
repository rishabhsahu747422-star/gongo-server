'use strict';

const { createDateShifter } = require('../helpers/relativeDates');

// Rental fixtures are written as readable calendar literals, but relDate() shifts them all
// by the same whole number of weeks so the earliest one always lands 14-20 days after today.
// Time-of-day, weekday and spacing between fixtures (durations, overlaps, grace periods)
// are unchanged, so prices and availability semantics are identical whenever the suite runs.
const relDate = createDateShifter('2026-11-01');

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

describe('Customer Bookings Integration Tests — Phase 8', () => {
  let app;
  let db;
  let mockPool;

  const customerA = {
    id: '11111111-1111-4111-8111-111111111111',
    role: 'customer',
    name: 'Customer Alice',
    countryCode: '+91',
    phone: '9871110001',
    email: 'alice@example.com',
    authId: 'firebase-uid-alice',
  };

  const customerB = {
    id: '22222222-2222-4222-8222-222222222222',
    role: 'customer',
    name: 'Customer Bob',
    countryCode: '+91',
    phone: '9871110002',
    email: 'bob@example.com',
    authId: 'firebase-uid-bob',
  };

  const partnerUser = {
    id: '33333333-3333-4333-8333-333333333333',
    role: 'partner',
    name: 'Partner User',
    countryCode: '+91',
    phone: '9871110003',
    email: 'partner@example.com',
    authId: 'firebase-uid-partner',
  };

  const partnerId = '44444444-4444-4444-8444-444444444444';
  const shopId = '55555555-5555-4555-8555-555555555555';
  const categoryId = '66666666-6666-4666-8666-666666666666';

  const activeVehicleId = '77777777-7777-4777-8777-777777777777';
  const inactiveVehicleId = '88888888-8888-4888-8888-888888888888';

  const existingBookingIdA = '99999999-9999-4999-8999-999999999999';
  const existingBookingIdB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

    // Mock Firebase auth
    const mockFirebaseAuth = {
      verifyIdToken: jest.fn().mockImplementation(async (token) => {
        if (token === 'token-alice') {
          return { uid: customerA.authId, auth_time: Math.floor(Date.now() / 1000), role: 'customer' };
        }
        if (token === 'token-bob') {
          return { uid: customerB.authId, auth_time: Math.floor(Date.now() / 1000), role: 'customer' };
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

    // Seed users
    db.public.none(`
      INSERT INTO users (id, role, name, country_code, phone, email, auth_provider, auth_id, is_active)
      VALUES
        ('${customerA.id}', '${customerA.role}', '${customerA.name}', '${customerA.countryCode}',
         '${customerA.phone}', '${customerA.email}', 'firebase', '${customerA.authId}', true),
        ('${customerB.id}', '${customerB.role}', '${customerB.name}', '${customerB.countryCode}',
         '${customerB.phone}', '${customerB.email}', 'firebase', '${customerB.authId}', true),
        ('${partnerUser.id}', '${partnerUser.role}', '${partnerUser.name}', '${partnerUser.countryCode}',
         '${partnerUser.phone}', '${partnerUser.email}', 'firebase', '${partnerUser.authId}', true)
    `);

    // Seed partner & shop
    db.public.none(`
      INSERT INTO partners (id, user_id, business_name, verification_status, is_active)
      VALUES ('${partnerId}', '${partnerUser.id}', 'Super Bikes Rental', 'approved', true)
    `);

    db.public.none(`
      INSERT INTO shops (id, partner_id, shop_name, is_active)
      VALUES ('${shopId}', '${partnerId}', 'Indiranagar Hub', true)
    `);

    // Seed category
    db.public.none(`
      INSERT INTO vehicle_categories (id, name, slug)
      VALUES ('${categoryId}', 'Bike', 'bike-booking')
    `);

    // Seed active & inactive vehicles
    db.public.none(`
      INSERT INTO vehicles (
        id, shop_id, category_id, brand, model, vehicle_name,
        year, fuel_type, transmission, seats, price_per_hour, price_per_day,
        price_per_week, price_per_month, security_deposit, late_fee_per_hour,
        extra_km_charge, listing_status, pickup_address
      ) VALUES
        ('${activeVehicleId}', '${shopId}', '${categoryId}', 'Royal Enfield', 'Classic 350',
         'Royal Enfield Classic 350', 2023, 'PETROL', 'MANUAL', 2, 80.00, 700.00,
         4200.00, 15000.00, 2000.00, 100.00, 10.00, 'ACTIVE', 'Indiranagar Metro Station'),
        ('${inactiveVehicleId}', '${shopId}', '${categoryId}', 'Yamaha', 'R15',
         'Yamaha R15 V4', 2022, 'PETROL', 'MANUAL', 2, 90.00, 800.00,
         4800.00, 18000.00, 3000.00, 120.00, 12.00, 'INACTIVE', 'Indiranagar Metro Station')
    `);

    // Seed an existing booking for Customer A on activeVehicleId (relDate 2026-11-01 10:00 to 12:00 UTC)
    db.public.none(`
      INSERT INTO bookings (
        id, customer_id, vehicle_id, status, rental_type,
        start_at, end_at, base_amount, security_deposit, total_amount
      ) VALUES (
        '${existingBookingIdA}', '${customerA.id}', '${activeVehicleId}', 'PENDING', 'HOURLY',
        '${relDate('2026-11-01T10:00:00Z')}', '${relDate('2026-11-01T12:00:00Z')}', 160.00, 2000.00, 2160.00
      )
    `);

    // Seed an existing booking for Customer B (relDate 2026-11-05 10:00 to 2026-11-06 10:00 UTC)
    db.public.none(`
      INSERT INTO bookings (
        id, customer_id, vehicle_id, status, rental_type,
        start_at, end_at, base_amount, security_deposit, total_amount
      ) VALUES (
        '${existingBookingIdB}', '${customerB.id}', '${activeVehicleId}', 'COMPLETED', 'DAILY',
        '${relDate('2026-11-05T10:00:00Z')}', '${relDate('2026-11-06T10:00:00Z')}', 700.00, 2000.00, 2700.00
      )
    `);

    const adapter = db.adapters.createPg();
    mockPool = new adapter.Pool();
    pool.query = mockPool.query.bind(mockPool);
    pool.connect = mockPool.connect.bind(mockPool);

    app = createApp();
  });

  // ── Availability ───────────────────────────────────────────────────────────
  describe('GET /api/v1/bookings/availability', () => {
    it('8. returns available=true when no blocking booking overlaps interval', async () => {
      const res = await request(app)
        .get('/api/v1/bookings/availability')
        .set('Authorization', 'Bearer token-alice')
        .query({
          vehicleId: activeVehicleId,
          startAt: relDate('2026-11-01T14:00:00Z'),
          endAt: relDate('2026-11-01T16:00:00Z'),
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isAvailable).toBe(true);
    });

    it('9. detects overlapping booking and returns available=false', async () => {
      // Existing booking is 10:00 to 12:00. Query 11:00 to 13:00.
      const res = await request(app)
        .get('/api/v1/bookings/availability')
        .set('Authorization', 'Bearer token-alice')
        .query({
          vehicleId: activeVehicleId,
          startAt: relDate('2026-11-01T11:00:00Z'),
          endAt: relDate('2026-11-01T13:00:00Z'),
        });

      expect(res.status).toBe(200);
      expect(res.body.data.isAvailable).toBe(false);
      expect(res.body.data.reason).toBeDefined();
    });

    it('10. allows adjacent booking at the 1-hour grace boundary: [10:00, 12:00)+1h and [13:00, 15:00)', async () => {
      // Existing booking ends at 12:00; a 1-hour post-rental grace period blocks the
      // vehicle until 13:00 (BookingRepository.findOverlappingBooking, see
      // timeBasedAvailabilitySpecification.test.js). Interval stays half-open at 13:00.
      const graceRes = await request(app)
        .get('/api/v1/bookings/availability')
        .set('Authorization', 'Bearer token-alice')
        .query({
          vehicleId: activeVehicleId,
          startAt: relDate('2026-11-01T12:00:00Z'),
          endAt: relDate('2026-11-01T14:00:00Z'),
        });
      expect(graceRes.status).toBe(200);
      expect(graceRes.body.data.isAvailable).toBe(false);

      const res = await request(app)
        .get('/api/v1/bookings/availability')
        .set('Authorization', 'Bearer token-alice')
        .query({
          vehicleId: activeVehicleId,
          startAt: relDate('2026-11-01T13:00:00Z'),
          endAt: relDate('2026-11-01T15:00:00Z'),
        });

      expect(res.status).toBe(200);
      expect(res.body.data.isAvailable).toBe(true);
    });

    it('11. cancelled booking does not block future availability', async () => {
      const cancelledBookingId = crypto.randomUUID();
      db.public.none(`
        INSERT INTO bookings (
          id, customer_id, vehicle_id, status, rental_type,
          start_at, end_at, base_amount, total_amount
        ) VALUES (
          '${cancelledBookingId}', '${customerA.id}', '${activeVehicleId}', 'CANCELLED', 'HOURLY',
          '${relDate('2026-11-02T10:00:00Z')}', '${relDate('2026-11-02T12:00:00Z')}', 160.00, 2160.00
        )
      `);

      const res = await request(app)
        .get('/api/v1/bookings/availability')
        .set('Authorization', 'Bearer token-alice')
        .query({
          vehicleId: activeVehicleId,
          startAt: relDate('2026-11-02T10:00:00Z'),
          endAt: relDate('2026-11-02T12:00:00Z'),
        });

      expect(res.status).toBe(200);
      expect(res.body.data.isAvailable).toBe(true);
    });

    it('12. completed historical booking does not block availability', async () => {
      // existingBookingIdB is COMPLETED for relDate 2026-11-05 10:00 to 2026-11-06 10:00
      const res = await request(app)
        .get('/api/v1/bookings/availability')
        .set('Authorization', 'Bearer token-alice')
        .query({
          vehicleId: activeVehicleId,
          startAt: relDate('2026-11-05T10:00:00Z'),
          endAt: relDate('2026-11-06T10:00:00Z'),
        });

      expect(res.status).toBe(200);
      expect(res.body.data.isAvailable).toBe(true);
    });

    it('13. operational booking in ACCEPTED or IN_PROGRESS status blocks availability', async () => {
      const inProgressId = crypto.randomUUID();
      db.public.none(`
        INSERT INTO bookings (
          id, customer_id, vehicle_id, status, rental_type,
          start_at, end_at, base_amount, total_amount
        ) VALUES (
          '${inProgressId}', '${customerB.id}', '${activeVehicleId}', 'IN_PROGRESS', 'HOURLY',
          '${relDate('2026-11-03T10:00:00Z')}', '${relDate('2026-11-03T15:00:00Z')}', 400.00, 2400.00
        )
      `);

      const res = await request(app)
        .get('/api/v1/bookings/availability')
        .set('Authorization', 'Bearer token-alice')
        .query({
          vehicleId: activeVehicleId,
          startAt: relDate('2026-11-03T12:00:00Z'),
          endAt: relDate('2026-11-03T14:00:00Z'),
        });

      expect(res.status).toBe(200);
      expect(res.body.data.isAvailable).toBe(false);
    });

    it('14. rejects invalid time range in availability check with 400', async () => {
      const res = await request(app)
        .get('/api/v1/bookings/availability')
        .set('Authorization', 'Bearer token-alice')
        .query({
          vehicleId: activeVehicleId,
          startAt: relDate('2026-11-04T12:00:00Z'),
          endAt: relDate('2026-11-04T10:00:00Z'),
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  // ── Create Booking ─────────────────────────────────────────────────────────
  describe('POST /api/v1/bookings', () => {
    it('15. authenticated customer can create booking with status PENDING', async () => {
      const res = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', 'Bearer token-alice')
        .send({
          vehicleId: activeVehicleId,
          rentalType: 'DAILY',
          startAt: relDate('2026-11-10T10:00:00Z'),
          endAt: relDate('2026-11-12T10:00:00Z'),
          pickupAddress: 'Customer Delivery Point',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.booking).toBeDefined();

      const { booking } = res.body.data;
      expect(booking.customerId).toBe(customerA.id);
      expect(booking.vehicleId).toBe(activeVehicleId);
      expect(booking.status).toBe('PENDING');
      expect(booking.rentalType).toBe('DAILY');
      // 2 days at 700/day = 1400 base + 2000 deposit = 3400 total
      expect(booking.pricingSnapshot.baseAmount).toBe(1400);
      expect(booking.pricingSnapshot.securityDeposit).toBe(2000);
      expect(booking.pricingSnapshot.totalAmount).toBe(3400);
      expect(booking.vehicle).toBeDefined();
      expect(booking.vehicle.vehicleName).toBe('Royal Enfield Classic 350');
    });

    it('16. unauthenticated customer rejected with 401', async () => {
      const res = await request(app)
        .post('/api/v1/bookings')
        .send({
          vehicleId: activeVehicleId,
          rentalType: 'DAILY',
          startAt: relDate('2026-11-10T10:00:00Z'),
          endAt: relDate('2026-11-12T10:00:00Z'),
        });

      expect(res.status).toBe(401);
    });

    it('17. non-customer role rejected with 403', async () => {
      const res = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', 'Bearer token-partner')
        .send({
          vehicleId: activeVehicleId,
          rentalType: 'DAILY',
          startAt: relDate('2026-11-10T10:00:00Z'),
          endAt: relDate('2026-11-12T10:00:00Z'),
        });

      expect(res.status).toBe(403);
    });

    it('18. rejects customerId injection in body with 400', async () => {
      const res = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', 'Bearer token-alice')
        .send({
          customerId: customerB.id,
          vehicleId: activeVehicleId,
          rentalType: 'DAILY',
          startAt: relDate('2026-11-10T10:00:00Z'),
          endAt: relDate('2026-11-12T10:00:00Z'),
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('19. rejects partnerId injection in body with 400', async () => {
      const res = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', 'Bearer token-alice')
        .send({
          partnerId,
          vehicleId: activeVehicleId,
          rentalType: 'DAILY',
          startAt: relDate('2026-11-10T10:00:00Z'),
          endAt: relDate('2026-11-12T10:00:00Z'),
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('20. client cannot choose booking status', async () => {
      const res = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', 'Bearer token-alice')
        .send({
          status: 'COMPLETED',
          vehicleId: activeVehicleId,
          rentalType: 'DAILY',
          startAt: relDate('2026-11-10T10:00:00Z'),
          endAt: relDate('2026-11-12T10:00:00Z'),
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('21. client cannot choose payment status or total amount', async () => {
      const res = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', 'Bearer token-alice')
        .send({
          paymentStatus: 'PAID',
          totalAmount: 1.00,
          vehicleId: activeVehicleId,
          rentalType: 'DAILY',
          startAt: relDate('2026-11-10T10:00:00Z'),
          endAt: relDate('2026-11-12T10:00:00Z'),
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('22. inactive vehicle rejected with 400', async () => {
      const res = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', 'Bearer token-alice')
        .send({
          vehicleId: inactiveVehicleId,
          rentalType: 'DAILY',
          startAt: relDate('2026-11-20T10:00:00Z'),
          endAt: relDate('2026-11-21T10:00:00Z'),
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VEHICLE_NOT_ACTIVE');
    });

    it('23. overlapping booking attempt rejected with 409 BOOKING_VEHICLE_UNAVAILABLE', async () => {
      // existingBookingIdA occupies relDate 2026-11-01 10:00 to 12:00
      const res = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', 'Bearer token-bob')
        .send({
          vehicleId: activeVehicleId,
          rentalType: 'HOURLY',
          startAt: relDate('2026-11-01T11:00:00Z'),
          endAt: relDate('2026-11-01T13:00:00Z'),
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('BOOKING_VEHICLE_UNAVAILABLE');
    });
  });

  // ── Ownership & Listing ────────────────────────────────────────────────────
  describe('GET /api/v1/bookings & GET /api/v1/bookings/:bookingId', () => {
    it('28. Customer can list own bookings', async () => {
      const res = await request(app)
        .get('/api/v1/bookings')
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.bookings).toBeInstanceOf(Array);
      expect(res.body.data.pagination).toBeDefined();

      // Alice's booking should be in the list
      const ids = res.body.data.bookings.map((b) => b.id);
      expect(ids).toContain(existingBookingIdA);
    });

    it('29. Customer cannot see another customer bookings in list (tenant isolation)', async () => {
      const res = await request(app)
        .get('/api/v1/bookings')
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(200);
      const ids = res.body.data.bookings.map((b) => b.id);
      // Bob's booking must NOT appear in Alice's list
      expect(ids).not.toContain(existingBookingIdB);
    });

    it('30. Customer can view details of own booking', async () => {
      const res = await request(app)
        .get(`/api/v1/bookings/${existingBookingIdA}`)
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(200);
      expect(res.body.data.booking.id).toBe(existingBookingIdA);
      expect(res.body.data.booking.customerId).toBe(customerA.id);
    });

    it('31. Customer cannot view another customer booking by ID (returns 404)', async () => {
      const res = await request(app)
        .get(`/api/v1/bookings/${existingBookingIdB}`)
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('BOOKING_NOT_FOUND');
    });
  });

  // ── Cancellation ───────────────────────────────────────────────────────────
  describe('POST /api/v1/bookings/:bookingId/cancel', () => {
    it('32. Customer can cancel own cancellable booking', async () => {
      // Create a fresh booking to cancel
      const createRes = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', 'Bearer token-alice')
        .send({
          vehicleId: activeVehicleId,
          rentalType: 'HOURLY',
          startAt: relDate('2026-11-25T10:00:00Z'),
          endAt: relDate('2026-11-25T12:00:00Z'),
        });
      const toCancelId = createRes.body.data.booking.id;

      const res = await request(app)
        .post(`/api/v1/bookings/${toCancelId}/cancel`)
        .set('Authorization', 'Bearer token-alice')
        .send({ reason: 'Trip rescheduled' });

      expect(res.status).toBe(200);
      // Canonical status is lowercase (BOOKING_STATUS.CANCELLED = 'cancelled' in src/constants/booking.js)
      expect(res.body.data.booking.status).toBe('cancelled');
      expect(res.body.data.booking.cancellation.reason).toBe('Trip rescheduled');

      // Verify availability is freed
      const availRes = await request(app)
        .get('/api/v1/bookings/availability')
        .set('Authorization', 'Bearer token-bob')
        .query({
          vehicleId: activeVehicleId,
          startAt: relDate('2026-11-25T10:00:00Z'),
          endAt: relDate('2026-11-25T12:00:00Z'),
        });
      expect(availRes.body.data.isAvailable).toBe(true);
    });

    it('33. Customer cannot cancel another customer booking', async () => {
      const res = await request(app)
        .post(`/api/v1/bookings/${existingBookingIdB}/cancel`)
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('BOOKING_NOT_FOUND');
    });

    it('34. Customer cannot cancel a non-cancellable booking (e.g. COMPLETED)', async () => {
      const res = await request(app)
        .post(`/api/v1/bookings/${existingBookingIdB}/cancel`)
        .set('Authorization', 'Bearer token-bob');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BOOKING_NOT_CANCELLABLE');
    });
  });

  // ── Idempotency ────────────────────────────────────────────────────────────
  describe('Idempotency handling', () => {
    it('35. same booking request retry with Idempotency-Key returns original booking', async () => {
      const idemKey = 'test-idempotency-key-1';
      const payload = {
        vehicleId: activeVehicleId,
        rentalType: 'DAILY',
        startAt: relDate('2026-12-01T10:00:00Z'),
        endAt: relDate('2026-12-02T10:00:00Z'),
      };

      // First call
      const res1 = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', 'Bearer token-alice')
        .set('Idempotency-Key', idemKey)
        .send(payload);

      expect(res1.status).toBe(201);
      const originalBookingId = res1.body.data.booking.id;

      // Second identical call
      const res2 = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', 'Bearer token-alice')
        .set('Idempotency-Key', idemKey)
        .send(payload);

      expect(res2.status).toBe(200);
      expect(res2.body.data.booking.id).toBe(originalBookingId);

      // Verify in DB that only 1 booking was created
      const rows = db.public.many(
        `SELECT id FROM bookings WHERE start_at = '${relDate('2026-12-01T10:00:00Z')}' AND vehicle_id = '${activeVehicleId}'`,
      );
      expect(rows.length).toBe(1);
    });

    it('36. conflicting Idempotency-Key reuse with different payload returns 409', async () => {
      const idemKey = 'test-idempotency-key-conflict';

      await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', 'Bearer token-alice')
        .set('Idempotency-Key', idemKey)
        .send({
          vehicleId: activeVehicleId,
          rentalType: 'DAILY',
          startAt: relDate('2026-12-05T10:00:00Z'),
          endAt: relDate('2026-12-06T10:00:00Z'),
        });

      // Same key, different rentalType / dates
      const resConflict = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', 'Bearer token-alice')
        .set('Idempotency-Key', idemKey)
        .send({
          vehicleId: activeVehicleId,
          rentalType: 'HOURLY',
          startAt: relDate('2026-12-07T10:00:00Z'),
          endAt: relDate('2026-12-07T12:00:00Z'),
        });

      expect(resConflict.status).toBe(409);
      expect(resConflict.body.code).toBe('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD');
    });
  });
});
