'use strict';

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
const { daysFromNowAt } = require('../helpers/relativeDates');

// FUTURE50 must stay "not yet active" no matter when the suite runs: its window
// opens one year from today (UTC midnight) and lasts one year, mirroring the
// original fixed 2027-01-01..2027-12-31 window.
const futureCouponValidFrom = daysFromNowAt(365, 0, 0, 0);
const futureCouponValidUntil = daysFromNowAt(730, 23, 59, 59);

describe('Coupons Validation Integration Tests — Phase 9', () => {
  let app;
  let db;
  let mockPool;

  const customer1 = {
    id: '11111111-1111-4111-8111-111111111111',
    role: 'customer',
    name: 'Customer One',
    countryCode: '+91',
    phone: '9876543210',
    email: 'c1@example.com',
    authId: 'auth-c1',
  };

  const customer2 = {
    id: '22222222-2222-4222-8222-222222222222',
    role: 'customer',
    name: 'Customer Two',
    countryCode: '+91',
    phone: '9876543211',
    email: 'c2@example.com',
    authId: 'auth-c2',
  };

  const partnerUser = {
    id: '33333333-3333-4333-8333-333333333333',
    role: 'partner',
    name: 'Partner User',
    countryCode: '+91',
    phone: '9876543212',
    email: 'partner@example.com',
    authId: 'auth-partner',
  };

  const partnerId = '44444444-4444-4444-8444-444444444444';
  const shopId = '55555555-5555-4555-8555-555555555555';
  let categoryId;
  const vehicleId = '77777777-7777-4777-8777-777777777777';

  const couponExhaustedId = '88888888-8888-4888-8888-888888888888';
  const couponPerCustId = '99999999-9999-4999-8999-999999999999';

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

    // Seed partner & shop & category
    db.public.none(`
      INSERT INTO partners (id, user_id, business_name, verification_status, is_active)
      VALUES ('${partnerId}', '${partnerUser.id}', 'Super Rentals', 'approved', true);

      INSERT INTO shops (id, partner_id, shop_name, is_active)
      VALUES ('${shopId}', '${partnerId}', 'Main Branch', true);
    `);

    const cat = db.public.one("SELECT id FROM vehicle_categories WHERE slug = 'bike'");
    categoryId = cat.id;

    // Seed vehicle
    db.public.none(`
      INSERT INTO vehicles (
        id, shop_id, category_id,
        vehicle_name, brand, model, year, registration_number,
        fuel_type, transmission, seats,
        price_per_hour, price_per_day, price_per_week, price_per_month,
        security_deposit, late_fee_per_hour, extra_km_charge,
        listing_status, pickup_address
      ) VALUES (
        '${vehicleId}', '${shopId}', '${categoryId}',
        'Yamaha MT-15', 'Yamaha', 'MT-15', 2023, 'KA01AB9999',
        'PETROL', 'MANUAL', 2,
        100.00, 800.00, 4800.00, 16000.00,
        2000.00, 150.00, 10.00,
        'ACTIVE', 'Koramangala 5th Block'
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
        gen_random_uuid(), 'ACTIVE20', '20% off up to 200', 'PERCENTAGE', 20.00,
        200.00, 200.00, 500, 2,
        '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', true
      ),
      (
        gen_random_uuid(), 'INACTIVE10', 'Inactive coupon', 'PERCENTAGE', 10.00,
        0.00, NULL, 100, 1,
        '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', false
      ),
      (
        gen_random_uuid(), 'EXPIRED30', 'Expired coupon', 'FIXED', 100.00,
        0.00, NULL, 100, 1,
        '2025-01-01T00:00:00Z', '2025-06-01T00:00:00Z', true
      ),
      (
        gen_random_uuid(), 'FUTURE50', 'Future coupon', 'FIXED', 50.00,
        0.00, NULL, 100, 1,
        '${futureCouponValidFrom}', '${futureCouponValidUntil}', true
      ),
      (
        gen_random_uuid(), 'MIN1000', 'Requires 1000 min', 'FIXED', 200.00,
        1000.00, NULL, 100, 1,
        '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', true
      ),
      (
        '${couponExhaustedId}', 'EXHAUSTED', 'Usage limit reached', 'FIXED', 50.00,
        0.00, NULL, 1, 1,
        '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', true
      ),
      (
        '${couponPerCustId}', 'PERCUST1', '1 per customer', 'FIXED', 50.00,
        0.00, NULL, 100, 1,
        '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', true
      );

      -- Seed redemptions to exhaust EXHAUSTED and PERCUST1 for customer1
      INSERT INTO coupon_redemptions (coupon_id, customer_id, discount_amount)
      VALUES
        ('${couponExhaustedId}', '${customer2.id}', 50.00),
        ('${couponPerCustId}', '${customer1.id}', 50.00);
    `);

    const adapter = db.adapters.createPg();
    mockPool = new adapter.Pool();
    pool.query = mockPool.query.bind(mockPool);
    pool.connect = mockPool.connect.bind(mockPool);

    app = createApp();
  });

  describe('POST /api/v1/coupons/validate', () => {
    it('validates active percentage coupon successfully', async () => {
      const res = await request(app)
        .post('/api/v1/coupons/validate')
        .set('Authorization', 'Bearer token-c1')
        .send({
          code: 'ACTIVE20',
          vehicleId,
          rentalType: 'DAILY',
          startAt: '2026-10-10T10:00:00Z',
          endAt: '2026-10-11T10:00:00Z', // 1 day = 800, 20% = 160
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({
        isValid: true,
        code: 'ACTIVE20',
        discountType: 'PERCENTAGE',
        discountValue: 20,
        discountAmount: 160,
      });
    });

    it('handles case-insensitivity in coupon code', async () => {
      const res = await request(app)
        .post('/api/v1/coupons/validate')
        .set('Authorization', 'Bearer token-c1')
        .send({
          code: 'active20', // lowercase
          vehicleId,
          rentalType: 'DAILY',
          startAt: '2026-10-10T10:00:00Z',
          endAt: '2026-10-11T10:00:00Z',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.isValid).toBe(true);
      expect(res.body.data.code).toBe('ACTIVE20');
    });

    it('rejects inactive coupon with 400 and COUPON_NOT_ACTIVE', async () => {
      const res = await request(app)
        .post('/api/v1/coupons/validate')
        .set('Authorization', 'Bearer token-c1')
        .send({
          code: 'INACTIVE10',
          vehicleId,
          rentalType: 'DAILY',
          startAt: '2026-10-10T10:00:00Z',
          endAt: '2026-10-11T10:00:00Z',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('COUPON_NOT_ACTIVE');
    });

    it('rejects expired coupon with 400 and COUPON_EXPIRED', async () => {
      const res = await request(app)
        .post('/api/v1/coupons/validate')
        .set('Authorization', 'Bearer token-c1')
        .send({
          code: 'EXPIRED30',
          vehicleId,
          rentalType: 'DAILY',
          startAt: '2026-10-10T10:00:00Z',
          endAt: '2026-10-11T10:00:00Z',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('COUPON_EXPIRED');
    });

    it('rejects not-yet-active coupon with 400 and COUPON_NOT_ACTIVE', async () => {
      const res = await request(app)
        .post('/api/v1/coupons/validate')
        .set('Authorization', 'Bearer token-c1')
        .send({
          code: 'FUTURE50',
          vehicleId,
          rentalType: 'DAILY',
          startAt: '2026-10-10T10:00:00Z',
          endAt: '2026-10-11T10:00:00Z',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('COUPON_NOT_ACTIVE');
    });

    it('rejects when minimum booking amount is not met', async () => {
      const res = await request(app)
        .post('/api/v1/coupons/validate')
        .set('Authorization', 'Bearer token-c1')
        .send({
          code: 'MIN1000',
          vehicleId,
          rentalType: 'DAILY',
          startAt: '2026-10-10T10:00:00Z',
          endAt: '2026-10-11T10:00:00Z', // 800 < 1000
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('COUPON_MINIMUM_AMOUNT_NOT_MET');
    });

    it('rejects when global usage limit is reached', async () => {
      const res = await request(app)
        .post('/api/v1/coupons/validate')
        .set('Authorization', 'Bearer token-c1')
        .send({
          code: 'EXHAUSTED',
          vehicleId,
          rentalType: 'DAILY',
          startAt: '2026-10-10T10:00:00Z',
          endAt: '2026-10-11T10:00:00Z',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('COUPON_USAGE_LIMIT_REACHED');
    });

    it('rejects when per-customer redemption limit is reached', async () => {
      const res = await request(app)
        .post('/api/v1/coupons/validate')
        .set('Authorization', 'Bearer token-c1')
        .send({
          code: 'PERCUST1',
          vehicleId,
          rentalType: 'DAILY',
          startAt: '2026-10-10T10:00:00Z',
          endAt: '2026-10-11T10:00:00Z',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('COUPON_CUSTOMER_LIMIT_REACHED');
    });

    it('allows another customer to use coupon when only first customer hit limit', async () => {
      const res = await request(app)
        .post('/api/v1/coupons/validate')
        .set('Authorization', 'Bearer token-c2')
        .send({
          code: 'PERCUST1',
          vehicleId,
          rentalType: 'DAILY',
          startAt: '2026-10-10T10:00:00Z',
          endAt: '2026-10-11T10:00:00Z',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.isValid).toBe(true);
    });

    it('returns 404 for unknown coupon code', async () => {
      const res = await request(app)
        .post('/api/v1/coupons/validate')
        .set('Authorization', 'Bearer token-c1')
        .send({
          code: 'DOESNOTEXIST',
          vehicleId,
          rentalType: 'DAILY',
          startAt: '2026-10-10T10:00:00Z',
          endAt: '2026-10-11T10:00:00Z',
        });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('INVALID_COUPON');
    });

    it('rejects unauthenticated request with 401', async () => {
      const res = await request(app)
        .post('/api/v1/coupons/validate')
        .send({
          code: 'ACTIVE20',
          vehicleId,
          rentalType: 'DAILY',
          startAt: '2026-10-10T10:00:00Z',
          endAt: '2026-10-11T10:00:00Z',
        });

      expect(res.status).toBe(401);
    });

    it('rejects non-customer role with 403', async () => {
      const res = await request(app)
        .post('/api/v1/coupons/validate')
        .set('Authorization', 'Bearer token-partner')
        .send({
          code: 'ACTIVE20',
          vehicleId,
          rentalType: 'DAILY',
          startAt: '2026-10-10T10:00:00Z',
          endAt: '2026-10-11T10:00:00Z',
        });

      expect(res.status).toBe(403);
    });
  });
});
