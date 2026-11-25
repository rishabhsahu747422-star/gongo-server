'use strict';

const { createDateShifter } = require('../helpers/relativeDates');

// Rental fixtures are written as readable calendar literals, but relDate() shifts them all
// by the same whole number of weeks so the earliest one always lands 14-20 days after today.
// Time-of-day, weekday and spacing between fixtures (durations, overlaps, grace periods)
// are unchanged, so prices and availability semantics are identical whenever the suite runs.
const relDate = createDateShifter('2026-11-20');

const request = require('supertest');
const { newDb, DataType } = require('pg-mem');
const crypto = require('crypto');

const { pool } = require('../../src/config/database');
const { setMockFirebaseAuth } = require('../../src/config/firebase');
const { createApp } = require('../../src/app');
const cashfreeProvider = require('../../src/services/payment/providers/cashfree.provider');

const usersMigration = require('../../database/migrations/1726300000000_create-users-table');
const partnersShopsMigration = require('../../database/migrations/1726600000000_create-partners-shops-table');
const categoriesCitiesMigration = require('../../database/migrations/1726700000000_create-categories-cities-table');
const vehiclesMigration = require('../../database/migrations/1726800000000_create-vehicles-table');
const vehicleImagesMigration = require('../../database/migrations/1726900000000_create-vehicle-images-table');
const bookingsMigration = require('../../database/migrations/1727000000000_create-bookings-table');
const idempotencyMigration = require('../../database/migrations/1727100000000_create-idempotency-keys-table');
const couponsMigration = require('../../database/migrations/1727200000000_create-coupons-table');
const addCouponColumnsMigration = require('../../database/migrations/1727300000000_add-coupon-columns-to-bookings');
const paymentsMigration = require('../../database/migrations/1727400000000_create-payments-table');

describe('Customer Cashfree Sandbox Integration Flow', () => {
  let app;
  let db;
  let mockPool;

  const customerAlice = {
    id: '11111111-1111-4111-8111-111111111111',
    role: 'customer',
    name: 'Alice Customer',
    countryCode: '+91',
    phone: '9871110001',
    email: 'alice@example.com',
    authId: 'auth-uid-alice',
  };

  const partnerUser = {
    id: '33333333-3333-4333-8333-333333333333',
    role: 'partner',
    name: 'Partner User',
    countryCode: '+91',
    phone: '9871110003',
    email: 'partner@example.com',
    authId: 'auth-uid-partner',
  };

  const partnerId = '44444444-4444-4444-8444-444444444444';
  const shopId = '55555555-5555-4555-8555-555555555555';
  let categoryId;
  const vehicleId = '66666666-6666-4666-8666-666666666666';

  let bookingAlice;

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
    await paymentsMigration.up(pgm);

    db.public.none(`
      INSERT INTO users (id, role, name, country_code, phone, email, auth_provider, auth_id, is_active)
      VALUES
        ('${customerAlice.id}', 'customer', '${customerAlice.name}', '${customerAlice.countryCode}', '${customerAlice.phone}', '${customerAlice.email}', 'firebase', '${customerAlice.authId}', true),
        ('${partnerUser.id}', 'partner', '${partnerUser.name}', '${partnerUser.countryCode}', '${partnerUser.phone}', '${partnerUser.email}', 'firebase', '${partnerUser.authId}', true);

      INSERT INTO partners (id, user_id, business_name, verification_status, is_active)
      VALUES ('${partnerId}', '${partnerUser.id}', 'Alice Rentals Hub', 'approved', true);

      INSERT INTO shops (id, partner_id, shop_name, is_active)
      VALUES ('${shopId}', '${partnerId}', 'Alice Shop', true);
    `);

    const cat = db.public.one("SELECT id FROM vehicle_categories WHERE slug = 'bike'");
    categoryId = cat.id;

    db.public.none(`
      INSERT INTO vehicles (
        id, shop_id, category_id, brand, model, vehicle_name,
        year, fuel_type, transmission, seats, price_per_hour, price_per_day,
        price_per_week, price_per_month, security_deposit, late_fee_per_hour,
        extra_km_charge, listing_status, pickup_address
      ) VALUES (
        '${vehicleId}', '${shopId}', '${categoryId}', 'Royal Enfield', 'Hunter 350',
        'Royal Enfield Hunter 350', 2023, 'PETROL', 'MANUAL', 2,
        80.00, 700.00, 4200.00, 15000.00, 2000.00, 100.00, 10.00, 'ACTIVE', 'Bangalore Hub'
      );
    `);

    const adapter = db.adapters.createPg();
    mockPool = new adapter.Pool();
    pool.query = mockPool.query.bind(mockPool);
    pool.connect = mockPool.connect.bind(mockPool);

    setMockFirebaseAuth({
      verifyIdToken: async (token) => {
        if (token === 'token-alice') {
          return { uid: customerAlice.authId, phone_number: '+919871110001' };
        }
        throw new Error('Invalid token');
      },
    });

    app = createApp();
  });

  beforeEach(() => {
    bookingAlice = crypto.randomUUID();

    db.public.none(`
      INSERT INTO bookings (
        id, customer_id, vehicle_id, status, rental_type,
        start_at, end_at, base_amount, security_deposit, total_amount
      ) VALUES (
        '${bookingAlice}', '${customerAlice.id}', '${vehicleId}', 'PAYMENT_PENDING', 'DAILY',
        '${relDate('2026-11-20T10:00:00Z')}', '${relDate('2026-11-21T10:00:00Z')}', 700.00, 2000.00, 2700.00
      );
    `);
  });

  describe('Cashfree PG Sandbox Mode Verification', () => {
    it('1. Cashfree provider operates in Sandbox mode with valid checkout session', async () => {
      expect(cashfreeProvider.envMode).toBe('SANDBOX');
      expect(cashfreeProvider.baseUrl).toContain('sandbox.cashfree.com');

      const res = await request(app)
        .post(`/api/v1/bookings/${bookingAlice}/payment`)
        .set('Authorization', 'Bearer token-alice')
        .send({});

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.payment).toBeDefined();

      const { payment } = res.body.data;
      expect(payment.provider).toBe('CASHFREE');
      expect(payment.amount).toBe(700.00);
      expect(payment.currency).toBe('INR');
      expect(payment.paymentSessionId).toBeDefined();
      expect(typeof payment.paymentSessionId).toBe('string');
      expect(payment.paymentSessionId.length).toBeGreaterThan(10);
    });

    it('2. Repeated initiatePayment request returns existing active order (idempotent)', async () => {
      const res1 = await request(app)
        .post(`/api/v1/bookings/${bookingAlice}/payment`)
        .set('Authorization', 'Bearer token-alice')
        .send({});

      expect(res1.status).toBe(201);
      const order1 = res1.body.data.payment;

      const res2 = await request(app)
        .post(`/api/v1/bookings/${bookingAlice}/payment`)
        .set('Authorization', 'Bearer token-alice')
        .send({});

      expect(res2.status).toBe(200);
      const order2 = res2.body.data.payment;

      expect(order2.id).toBe(order1.id);
      expect(order2.bookingId).toBe(bookingAlice);
      expect(order2.providerOrderId).toBe(order1.providerOrderId);
    });

    it('3. Test webhook simulation endpoint transitions payment to SUCCESS and booking to PAYMENT_COMPLETED', async () => {
      // Step A: Initiate payment
      const initRes = await request(app)
        .post(`/api/v1/bookings/${bookingAlice}/payment`)
        .set('Authorization', 'Bearer token-alice')
        .send({});

      expect(initRes.status).toBe(201);
      const { payment } = initRes.body.data;

      // Step B: Simulate Cashfree Webhook callback
      const simRes = await request(app)
        .post('/api/v1/payments/test/simulate-webhook')
        .set('Authorization', 'Bearer token-alice')
        .send({
          bookingId: bookingAlice,
          orderId: payment.providerOrderId,
          paymentStatus: 'SUCCESS',
        });

      expect(simRes.status).toBe(200);
      expect(simRes.body.success).toBe(true);

      // Step C: Verify authoritative status polling
      const statusRes = await request(app)
        .get(`/api/v1/bookings/${bookingAlice}/payment`)
        .set('Authorization', 'Bearer token-alice');

      expect(statusRes.status).toBe(200);
      expect(statusRes.body.data.payment.isPaid).toBe(true);
      expect(statusRes.body.data.payment.status).toBe('paid');

      // Step D: Verify booking status transitioned
      const bookingRow = db.public.one(`SELECT status FROM bookings WHERE id = '${bookingAlice}'`);
      expect(bookingRow.status.toUpperCase()).toBe('PAYMENT_COMPLETED');
    });

    it('4. Rejects Dev Dummy Payment bypass attempt in booking creation', async () => {
      const prevVal = process.env.DEV_DUMMY_PAYMENT_ENABLED;
      process.env.DEV_DUMMY_PAYMENT_ENABLED = 'false';
      try {
        const res = await request(app)
          .post('/api/v1/bookings')
          .set('Authorization', 'Bearer token-alice')
          .send({
            vehicleId,
            startAt: relDate('2026-11-25T10:00:00Z'),
            endAt: relDate('2026-11-26T10:00:00Z'),
            rentalType: 'DAILY',
            isDevPayment: true,
          });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('DEV_PAYMENT_DISABLED');
      } finally {
        if (prevVal !== undefined) {
          process.env.DEV_DUMMY_PAYMENT_ENABLED = prevVal;
        } else {
          delete process.env.DEV_DUMMY_PAYMENT_ENABLED;
        }
      }
    });
  });
});
