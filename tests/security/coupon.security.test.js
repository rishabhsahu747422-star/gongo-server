'use strict';

const { createDateShifter } = require('../helpers/relativeDates');

// Rental fixtures are written as readable calendar literals, but relDate() shifts them all
// by the same whole number of weeks so the earliest one always lands 14-20 days after today.
// Time-of-day, weekday and spacing between fixtures (durations, overlaps, grace periods)
// are unchanged, so prices and availability semantics are identical whenever the suite runs.
const relDate = createDateShifter('2026-11-10');

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

describe('Coupon Security & Concurrency Tests — Phase 9', () => {
  let app;
  let db;
  let mockPool;

  const customer1 = {
    id: '10101010-1010-4010-8010-101010101010',
    role: 'customer',
    name: 'Security Alice',
    countryCode: '+91',
    phone: '9870000001',
    email: 'alice.sec@example.com',
    authId: 'auth-sec-alice',
  };

  const customer2 = {
    id: '20202020-2020-4020-8020-202020202020',
    role: 'customer',
    name: 'Security Bob',
    countryCode: '+91',
    phone: '9870000002',
    email: 'bob.sec@example.com',
    authId: 'auth-sec-bob',
  };

  const partnerUser = {
    id: '30303030-3030-4030-8030-303030303030',
    role: 'partner',
    name: 'Partner Sec',
    countryCode: '+91',
    phone: '9870000003',
    email: 'partner.sec@example.com',
    authId: 'auth-sec-partner',
  };

  const partnerId = '40404040-4040-4040-8040-404040404040';
  const shopId = '50505050-5050-4050-8050-505050505050';
  let categoryId;
  const vehicle1Id = '60606060-6060-4060-8060-606060606060';
  const vehicle2Id = '70707070-7070-4070-8070-707070707070';

  const singleUseCouponId = '80808080-8080-4080-8080-808080808080';
  const perCustomerLimitCouponId = '90909090-9090-4090-8090-909090909090';

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
        if (token === 'token-alice') {
          return { uid: customer1.authId, auth_time: Math.floor(Date.now() / 1000), role: 'customer' };
        }
        if (token === 'token-bob') {
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

    // Seed users
    db.public.none(`
      INSERT INTO users (id, role, name, country_code, phone, email, auth_provider, auth_id, is_active)
      VALUES
        ('${customer1.id}', '${customer1.role}', '${customer1.name}', '${customer1.countryCode}',
         '${customer1.phone}', '${customer1.email}', 'firebase', '${customer1.authId}', true),
        ('${customer2.id}', '${customer2.role}', '${customer2.name}', '${customer2.countryCode}',
         '${customer2.phone}', '${customer2.email}', 'firebase', '${customer2.authId}', true),
        ('${partnerUser.id}', '${partnerUser.role}', '${partnerUser.name}', '${partnerUser.countryCode}',
         '${partnerUser.phone}', '${partnerUser.email}', 'firebase', '${partnerUser.authId}', true);
    `);

    // Seed partner & shop
    db.public.none(`
      INSERT INTO partners (id, user_id, business_name, verification_status, is_active)
      VALUES ('${partnerId}', '${partnerUser.id}', 'Security Motors', 'approved', true);

      INSERT INTO shops (id, partner_id, shop_name, is_active)
      VALUES ('${shopId}', '${partnerId}', 'Security Hub', true);
    `);

    const cat = db.public.one("SELECT id FROM vehicle_categories WHERE slug = 'bike'");
    categoryId = cat.id;

    // Seed 2 distinct active vehicles so two concurrent bookings don't collide on vehicle lock
    db.public.none(`
      INSERT INTO vehicles (
        id, shop_id, category_id,
        vehicle_name, brand, model, year, registration_number,
        fuel_type, transmission, seats,
        price_per_hour, price_per_day, price_per_week, price_per_month,
        security_deposit, late_fee_per_hour, extra_km_charge,
        listing_status, pickup_address
      ) VALUES
      (
        '${vehicle1Id}', '${shopId}', '${categoryId}',
        'KTM Duke 390', 'KTM', 'Duke 390', 2023, 'KA01KT1234',
        'PETROL', 'MANUAL', 2,
        150.00, 1200.00, 7200.00, 24000.00,
        3000.00, 200.00, 15.00,
        'ACTIVE', 'Security Hub MG Road'
      ),
      (
        '${vehicle2Id}', '${shopId}', '${categoryId}',
        'BMW G310R', 'BMW', 'G310R', 2023, 'KA01BM5678',
        'PETROL', 'MANUAL', 2,
        160.00, 1300.00, 7800.00, 26000.00,
        3000.00, 200.00, 15.00,
        'ACTIVE', 'Security Hub MG Road'
      );
    `);

    // Seed coupons
    db.public.none(`
      INSERT INTO coupons (
        id, code, description, discount_type, discount_value,
        min_booking_amount, max_discount_amount, usage_limit,
        per_customer_limit, valid_from, valid_until, is_active
      ) VALUES
      (
        '${singleUseCouponId}', 'SINGLEUSE', 'Only 1 usage total allowed', 'FIXED', 100.00,
        0.00, NULL, 1, 1,
        '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', true
      ),
      (
        '${perCustomerLimitCouponId}', 'LIMITONE', '1 use per customer, total 10', 'FIXED', 100.00,
        0.00, NULL, 10, 1,
        '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', true
      );
    `);

    const adapter = db.adapters.createPg();
    mockPool = new adapter.Pool();
    pool.query = mockPool.query.bind(mockPool);
    pool.connect = mockPool.connect.bind(mockPool);

    app = createApp();
  });

  describe('Coupon Usage Limits & Race Condition Protection', () => {
    it('serializes concurrent coupon redemptions when usage_limit = 1: exactly one succeeds', async () => {
      // Alice on vehicle1 and Bob on vehicle2 both attempt to redeem SINGLEUSE simultaneously
      const [res1, res2] = await Promise.all([
        request(app)
          .post('/api/v1/bookings')
          .set('Authorization', 'Bearer token-alice')
          .send({
            vehicleId: vehicle1Id,
            rentalType: 'DAILY',
            startAt: relDate('2026-11-10T10:00:00Z'),
            endAt: relDate('2026-11-11T10:00:00Z'),
            couponCode: 'SINGLEUSE',
          }),
        request(app)
          .post('/api/v1/bookings')
          .set('Authorization', 'Bearer token-bob')
          .send({
            vehicleId: vehicle2Id,
            rentalType: 'DAILY',
            startAt: relDate('2026-11-10T10:00:00Z'),
            endAt: relDate('2026-11-11T10:00:00Z'),
            couponCode: 'SINGLEUSE',
          }),
      ]);

      const statuses = [res1.status, res2.status];
      expect(statuses).toContain(201);
      expect(statuses).toContain(400);

      const failedRes = res1.status === 400 ? res1 : res2;
      expect(failedRes.body.code).toBe('COUPON_USAGE_LIMIT_REACHED');

      // Verify redemption count in database is strictly 1
      const redemptions = await mockPool.query(
        'SELECT * FROM coupon_redemptions WHERE coupon_id = $1',
        [singleUseCouponId],
      );
      expect(redemptions.rows.length).toBe(1);
    });

    it('enforces per_customer_limit when customer makes concurrent requests', async () => {
      // Alice tries to use LIMITONE twice concurrently on different dates
      const [res1, res2] = await Promise.all([
        request(app)
          .post('/api/v1/bookings')
          .set('Authorization', 'Bearer token-alice')
          .send({
            vehicleId: vehicle1Id,
            rentalType: 'DAILY',
            startAt: relDate('2026-11-15T10:00:00Z'),
            endAt: relDate('2026-11-16T10:00:00Z'),
            couponCode: 'LIMITONE',
          }),
        request(app)
          .post('/api/v1/bookings')
          .set('Authorization', 'Bearer token-alice')
          .send({
            vehicleId: vehicle1Id,
            rentalType: 'DAILY',
            startAt: relDate('2026-11-17T10:00:00Z'),
            endAt: relDate('2026-11-18T10:00:00Z'),
            couponCode: 'LIMITONE',
          }),
      ]);

      const statuses = [res1.status, res2.status];
      expect(statuses).toContain(201);
      expect(statuses).toContain(400);

      const failedRes = res1.status === 400 ? res1 : res2;
      expect(failedRes.body.code).toBe('COUPON_CUSTOMER_LIMIT_REACHED');
    });
  });

  describe('Anti-Tampering & Security Protections in Booking Creation', () => {
    it('rejects client attempting to inject discountAmount or discount_amount in booking request', async () => {
      const res = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', 'Bearer token-bob')
        .send({
          vehicleId: vehicle2Id,
          rentalType: 'DAILY',
          startAt: relDate('2026-11-20T10:00:00Z'),
          endAt: relDate('2026-11-21T10:00:00Z'),
          discountAmount: 999.00,
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.message).toMatch(/not allowed/i);
    });

    it('rejects client attempting to inject couponId directly in booking request', async () => {
      const res = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', 'Bearer token-bob')
        .send({
          vehicleId: vehicle2Id,
          rentalType: 'DAILY',
          startAt: relDate('2026-11-20T10:00:00Z'),
          endAt: relDate('2026-11-21T10:00:00Z'),
          couponId: perCustomerLimitCouponId,
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.message).toMatch(/not allowed/i);
    });

    it('records authoritative pricing and coupon snapshot on booking', async () => {
      const res = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', 'Bearer token-bob')
        .send({
          vehicleId: vehicle2Id,
          rentalType: 'DAILY',
          startAt: relDate('2026-11-20T10:00:00Z'),
          endAt: relDate('2026-11-21T10:00:00Z'),
          couponCode: 'LIMITONE',
        });

      expect(res.status).toBe(201);
      const { booking } = res.body.data;
      expect(booking.pricingSnapshot.couponCode).toBe('LIMITONE');
      expect(booking.pricingSnapshot.couponId).toBe(perCustomerLimitCouponId);
      expect(booking.pricingSnapshot.discountAmount).toBe(100.00);
      expect(booking.pricingSnapshot.baseAmount).toBe(1300.00);
      expect(booking.pricingSnapshot.totalAmount).toBe(4200.00); // (1300 - 100) + 3000 deposit
    });

    it('safely handles SQL injection attempts in couponCode parameter without error', async () => {
      const res = await request(app)
        .post('/api/v1/coupons/validate')
        .set('Authorization', 'Bearer token-alice')
        .send({
          code: "' OR '1'='1' --",
          vehicleId: vehicle1Id,
          rentalType: 'DAILY',
          startAt: relDate('2026-11-25T10:00:00Z'),
          endAt: relDate('2026-11-26T10:00:00Z'),
        });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('INVALID_COUPON');
    });
  });
});
