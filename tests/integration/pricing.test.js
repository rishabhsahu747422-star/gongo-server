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

describe('Pricing Quote Integration Tests — Phase 9', () => {
  let app;
  let db;
  let mockPool;

  const customer = {
    id: '11111111-1111-4111-8111-111111111111',
    role: 'customer',
    name: 'Customer One',
    countryCode: '+91',
    phone: '9876543210',
    email: 'customer1@example.com',
    authId: 'auth-cust-1',
  };

  const partnerUser = {
    id: '22222222-2222-4222-8222-222222222222',
    role: 'partner',
    name: 'Partner User',
    countryCode: '+91',
    phone: '9876543211',
    email: 'partner@example.com',
    authId: 'auth-partner-1',
  };

  const partnerId = '33333333-3333-4333-8333-333333333333';
  const shopId = '44444444-4444-4444-8444-444444444444';
  const categoryId = '55555555-5555-4555-8555-555555555555';
  const activeVehicleId = '66666666-6666-4666-8666-666666666666';
  const inactiveVehicleId = '77777777-7777-4777-8777-777777777777';

  // Rental windows must be in the future (validator rejects startAt in the past),
  // so anchor them relative to "now" instead of hardcoded calendar dates.
  const rentalAt = (dayOffset, hour) => daysFromNowAt(10 + dayOffset, hour);

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
        if (token === 'token-customer') {
          return { uid: customer.authId, auth_time: Math.floor(Date.now() / 1000), role: 'customer' };
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
        ('${customer.id}', '${customer.role}', '${customer.name}', '${customer.countryCode}',
         '${customer.phone}', '${customer.email}', 'firebase', '${customer.authId}', true),
        ('${partnerUser.id}', '${partnerUser.role}', '${partnerUser.name}', '${partnerUser.countryCode}',
         '${partnerUser.phone}', '${partnerUser.email}', 'firebase', '${partnerUser.authId}', true);
    `);

    // Seed partner and shop
    db.public.none(`
      INSERT INTO partners (id, user_id, business_name, verification_status, is_active)
      VALUES ('${partnerId}', '${partnerUser.id}', 'Super Rentals', 'approved', true);

      INSERT INTO shops (id, partner_id, shop_name, is_active)
      VALUES ('${shopId}', '${partnerId}', 'Main Branch', true);

      INSERT INTO vehicle_categories (id, name, slug)
      VALUES ('${categoryId}', 'Scooter', 'scooter');
    `);

    // Seed vehicles
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
        '${activeVehicleId}', '${shopId}', '${categoryId}',
        'Honda Activa 6G', 'Honda', 'Activa 6G', 2023, 'KA01AB1234',
        'PETROL', 'AUTOMATIC', 2,
        50.00, 400.00, 2400.00, 8000.00,
        1000.00, 100.00, 5.00,
        'ACTIVE', 'Shop 101, MG Road, Bengaluru'
      ),
      (
        '${inactiveVehicleId}', '${shopId}', '${categoryId}',
        'Yamaha Fascino', 'Yamaha', 'Fascino', 2022, 'KA01AB5678',
        'PETROL', 'AUTOMATIC', 2,
        60.00, 500.00, 3000.00, 9500.00,
        1500.00, 120.00, 6.00,
        'INACTIVE', 'Shop 101, MG Road, Bengaluru'
      );
    `);

    // Seed coupons
    db.public.none(`
      INSERT INTO coupons (
        code, description, discount_type, discount_value,
        min_booking_amount, max_discount_amount, usage_limit,
        per_customer_limit, valid_from, valid_until, is_active
      ) VALUES
      (
        'SAVE50', '50% off up to 100', 'PERCENTAGE', 50.00,
        100.00, 100.00, 1000, 2,
        '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', true
      ),
      (
        'FLAT150', 'Flat 150 off min 300', 'FIXED', 150.00,
        300.00, NULL, 500, 1,
        '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', true
      ),
      (
        'BIGSPENDER', 'Flat 500 off min 5000', 'FIXED', 500.00,
        5000.00, NULL, 100, 1,
        '2026-01-01T00:00:00Z', '2099-12-31T23:59:59Z', true
      );
    `);

    const adapter = db.adapters.createPg();
    mockPool = new adapter.Pool();
    pool.query = mockPool.query.bind(mockPool);
    pool.connect = mockPool.connect.bind(mockPool);

    app = createApp();
  });

  describe('POST /api/v1/pricing/quote', () => {
    it('calculates authoritative quote for HOURLY rental', async () => {
      const res = await request(app)
        .post('/api/v1/pricing/quote')
        .set('Authorization', 'Bearer token-customer')
        .send({
          vehicleId: activeVehicleId,
          rentalType: 'HOURLY',
          startAt: rentalAt(0, 10),
          endAt: rentalAt(0, 13), // 3 hours * 50 = 150
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const { quote } = res.body.data;
      expect(quote.rentalType).toBe('HOURLY');
      expect(quote.duration.count).toBe(3);
      expect(quote.duration.unit).toBe('hours');
      expect(quote.breakdown.baseAmount).toBe(150.00);
      expect(quote.breakdown.securityDeposit).toBe(1000.00);
      expect(quote.breakdown.totalAmount).toBe(1150.00);
    });

    it('calculates authoritative quote for DAILY rental', async () => {
      const res = await request(app)
        .post('/api/v1/pricing/quote')
        .set('Authorization', 'Bearer token-customer')
        .send({
          vehicleId: activeVehicleId,
          rentalType: 'DAILY',
          startAt: rentalAt(0, 10),
          endAt: rentalAt(2, 10), // 2 days * 400 = 800
        });

      expect(res.status).toBe(200);
      const { quote } = res.body.data;
      expect(quote.rentalType).toBe('DAILY');
      expect(quote.duration.count).toBe(2);
      expect(quote.duration.unit).toBe('days');
      expect(quote.breakdown.baseAmount).toBe(800.00);
      expect(quote.breakdown.securityDeposit).toBe(1000.00);
      expect(quote.breakdown.totalAmount).toBe(1800.00);
    });

    it('calculates authoritative quote for WEEKLY rental', async () => {
      const res = await request(app)
        .post('/api/v1/pricing/quote')
        .set('Authorization', 'Bearer token-customer')
        .send({
          vehicleId: activeVehicleId,
          rentalType: 'WEEKLY',
          startAt: rentalAt(0, 10),
          endAt: rentalAt(7, 10), // 1 week * 2400 = 2400
        });

      expect(res.status).toBe(200);
      const { quote } = res.body.data;
      expect(quote.rentalType).toBe('WEEKLY');
      expect(quote.duration.count).toBe(1);
      expect(quote.breakdown.baseAmount).toBe(2400.00);
    });

    it('calculates quote with percentage coupon capped by max_discount_amount', async () => {
      const res = await request(app)
        .post('/api/v1/pricing/quote')
        .set('Authorization', 'Bearer token-customer')
        .send({
          vehicleId: activeVehicleId,
          rentalType: 'DAILY',
          startAt: rentalAt(0, 10),
          endAt: rentalAt(1, 10), // 1 day: base 400, 50% = 200, but cap is 100
          couponCode: 'SAVE50',
        });

      expect(res.status).toBe(200);
      const { quote } = res.body.data;
      expect(quote.breakdown.baseAmount).toBe(400.00);
      expect(quote.breakdown.discountAmount).toBe(100.00);
      expect(quote.breakdown.subtotal).toBe(300.00);
      expect(quote.breakdown.totalAmount).toBe(1300.00); // 300 + 1000 deposit
      expect(quote.appliedCoupon).toMatchObject({
        code: 'SAVE50',
        discountType: 'PERCENTAGE',
        discountAmount: 100.00,
      });
    });

    it('calculates quote with fixed discount coupon', async () => {
      const res = await request(app)
        .post('/api/v1/pricing/quote')
        .set('Authorization', 'Bearer token-customer')
        .send({
          vehicleId: activeVehicleId,
          rentalType: 'DAILY',
          startAt: rentalAt(0, 10),
          endAt: rentalAt(1, 10), // 1 day: base 400, flat 150 off
          couponCode: 'flat150', // case-insensitive
        });

      expect(res.status).toBe(200);
      const { quote } = res.body.data;
      expect(quote.breakdown.baseAmount).toBe(400.00);
      expect(quote.breakdown.discountAmount).toBe(150.00);
      expect(quote.breakdown.subtotal).toBe(250.00);
      expect(quote.breakdown.totalAmount).toBe(1250.00);
    });

    it('rejects coupon if min_booking_amount is not met', async () => {
      const res = await request(app)
        .post('/api/v1/pricing/quote')
        .set('Authorization', 'Bearer token-customer')
        .send({
          vehicleId: activeVehicleId,
          rentalType: 'HOURLY',
          startAt: rentalAt(0, 10),
          endAt: rentalAt(0, 11), // base 50 < min 5000 for BIGSPENDER
          couponCode: 'BIGSPENDER',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('COUPON_MINIMUM_AMOUNT_NOT_MET');
    });

    it('rejects forbidden price-tampering fields from client', async () => {
      const res = await request(app)
        .post('/api/v1/pricing/quote')
        .set('Authorization', 'Bearer token-customer')
        .send({
          vehicleId: activeVehicleId,
          rentalType: 'HOURLY',
          startAt: rentalAt(0, 10),
          endAt: rentalAt(0, 12),
          baseAmount: 1.00,
          totalAmount: 1.00,
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.message).toMatch(/not allowed/i);
    });

    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(app)
        .post('/api/v1/pricing/quote')
        .send({
          vehicleId: activeVehicleId,
          rentalType: 'DAILY',
          startAt: rentalAt(0, 10),
          endAt: rentalAt(1, 10),
        });

      expect(res.status).toBe(401);
    });

    it('rejects non-customer role with 403', async () => {
      const res = await request(app)
        .post('/api/v1/pricing/quote')
        .set('Authorization', 'Bearer token-partner')
        .send({
          vehicleId: activeVehicleId,
          rentalType: 'DAILY',
          startAt: rentalAt(0, 10),
          endAt: rentalAt(1, 10),
        });

      expect(res.status).toBe(403);
    });

    it('rejects inactive vehicle with 400', async () => {
      const res = await request(app)
        .post('/api/v1/pricing/quote')
        .set('Authorization', 'Bearer token-customer')
        .send({
          vehicleId: inactiveVehicleId,
          rentalType: 'DAILY',
          startAt: rentalAt(0, 10),
          endAt: rentalAt(1, 10),
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VEHICLE_NOT_ACTIVE');
    });

    it('rejects invalid time ranges where startAt >= endAt', async () => {
      const res = await request(app)
        .post('/api/v1/pricing/quote')
        .set('Authorization', 'Bearer token-customer')
        .send({
          vehicleId: activeVehicleId,
          rentalType: 'DAILY',
          startAt: rentalAt(2, 10),
          endAt: rentalAt(0, 10),
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });
});
