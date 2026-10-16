'use strict';

const { createDateShifter } = require('../helpers/relativeDates');

// Rental fixtures are written as readable calendar literals, but relDate() shifts them all
// by the same whole number of weeks so the earliest one always lands 14-20 days after today.
// Time-of-day, weekday and spacing between fixtures (durations, overlaps, grace periods)
// are unchanged, so prices and availability semantics are identical whenever the suite runs.
const relDate = createDateShifter('2026-12-01');

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

describe('Payment Security & Anti-Tampering Tests — Phase 10', () => {
  let app;
  let db;
  let mockPool;

  const SECRET_KEY = process.env.CASHFREE_SECRET_KEY || 'test_cf_secret_key';

  const customerAlice = {
    id: '10101010-1010-4010-8010-101010101010',
    role: 'customer',
    name: 'Security Alice',
    countryCode: '+91',
    phone: '9870000001',
    email: 'alice.sec@example.com',
    authId: 'auth-sec-alice',
  };

  const customerBob = {
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
  const vehicleId = '60606060-6060-4060-8060-606060606060';

  const aliceBookingId = '70707070-7070-4070-8070-707070707070';
  const bobBookingId = '80808080-8080-4080-8080-808080808080';
  const paidBookingId = '90909090-9090-4090-8090-909090909090';

  function signPayload(bodyString, timestamp = String(Date.now()), secret = SECRET_KEY) {
    const signature = crypto
      .createHmac('sha256', secret)
      .update(timestamp + bodyString)
      .digest('base64');

    return {
      'x-webhook-timestamp': timestamp,
      'x-webhook-signature': signature,
      'content-type': 'application/json',
    };
  }

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

    // Mock Firebase auth
    const mockFirebaseAuth = {
      verifyIdToken: jest.fn().mockImplementation(async (token) => {
        if (token === 'token-alice') {
          return { uid: customerAlice.authId, auth_time: Math.floor(Date.now() / 1000), role: 'customer' };
        }
        if (token === 'token-bob') {
          return { uid: customerBob.authId, auth_time: Math.floor(Date.now() / 1000), role: 'customer' };
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

    // Mock Cashfree provider delegate
    cashfreeProvider.setMockDelegate({
      createOrder: jest.fn().mockImplementation(
        async ({ orderId, orderAmount, orderCurrency }) => ({
          providerOrderId: orderId,
          paymentSessionId: `session_${orderId}`,
          orderStatus: 'ACTIVE',
          cfOrderId: 'cf_12345678',
          amount: orderAmount,
          currency: orderCurrency,
        }),
      ),
      getOrderStatus: jest.fn().mockResolvedValue({
        orderStatus: 'ACTIVE',
      }),
    });

    // Seed users
    db.public.none(`
      INSERT INTO users (id, role, name, country_code, phone, email, auth_provider, auth_id, is_active)
      VALUES
        ('${customerAlice.id}', '${customerAlice.role}', '${customerAlice.name}', '${customerAlice.countryCode}',
         '${customerAlice.phone}', '${customerAlice.email}', 'firebase', '${customerAlice.authId}', true),
        ('${customerBob.id}', '${customerBob.role}', '${customerBob.name}', '${customerBob.countryCode}',
         '${customerBob.phone}', '${customerBob.email}', 'firebase', '${customerBob.authId}', true),
        ('${partnerUser.id}', '${partnerUser.role}', '${partnerUser.name}', '${partnerUser.countryCode}',
         '${partnerUser.phone}', '${partnerUser.email}', 'firebase', '${partnerUser.authId}', true);

      INSERT INTO partners (id, user_id, business_name, verification_status, is_active)
      VALUES ('${partnerId}', '${partnerUser.id}', 'Security Partner Rentals', 'approved', true);

      INSERT INTO shops (id, partner_id, shop_name, is_active)
      VALUES ('${shopId}', '${partnerId}', 'Secure Central Hub', true);
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
        '${vehicleId}', '${shopId}', '${categoryId}', 'Honda', 'Activa 6G',
        'Honda Activa 6G', 2023, 'PETROL', 'AUTOMATIC', 2,
        60.00, 500.00, 3000.00, 10000.00, 1000.00, 80.00, 8.00, 'ACTIVE', 'Koramangala Hub'
      );
    `);

    const adapter = db.adapters.createPg();
    mockPool = new adapter.Pool();
    pool.query = mockPool.query.bind(mockPool);
    pool.connect = mockPool.connect.bind(mockPool);

    app = createApp();
  });

  beforeEach(async () => {
    db.public.none('DELETE FROM payments');
    db.public.none('DELETE FROM bookings');

    db.public.none(`
      INSERT INTO bookings (
        id, customer_id, vehicle_id, status, rental_type,
        start_at, end_at, base_amount, security_deposit, total_amount
      ) VALUES
        ('${aliceBookingId}', '${customerAlice.id}', '${vehicleId}', 'PENDING', 'DAILY',
         '${relDate('2026-12-01T10:00:00Z')}', '${relDate('2026-12-02T10:00:00Z')}', 500.00, 1000.00, 1500.00),
        ('${bobBookingId}', '${customerBob.id}', '${vehicleId}', 'PENDING', 'DAILY',
         '${relDate('2026-12-05T10:00:00Z')}', '${relDate('2026-12-06T10:00:00Z')}', 500.00, 1000.00, 1500.00),
        ('${paidBookingId}', '${customerAlice.id}', '${vehicleId}', 'PAYMENT_COMPLETED', 'DAILY',
         '${relDate('2026-12-10T10:00:00Z')}', '${relDate('2026-12-11T10:00:00Z')}', 500.00, 1000.00, 1500.00);

      INSERT INTO payments (
        booking_id, customer_id, provider, provider_order_id,
        provider_payment_id, amount, currency, status
      ) VALUES (
        '${paidBookingId}', '${customerAlice.id}', 'CASHFREE', 'cf_sec_paid_123',
        'cf_pay_completed', 1500.00, 'INR', 'SUCCESS'
      );
    `);
  });

  afterAll(() => {
    cashfreeProvider.setMockDelegate(null);
  });

  describe('1. Anti-Tampering & Server-Authoritative Amounts', () => {
    it('rejects client attempting to inject amount: { amount: 1 } with 400 Bad Request', async () => {
      const res = await request(app)
        .post(`/api/v1/bookings/${aliceBookingId}/payment`)
        .set('Authorization', 'Bearer token-alice')
        .send({ amount: 1 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/not allowed/i);
    });

    it('rejects client attempting to inject discount: { discount: 500 } with 400 Bad Request', async () => {
      const res = await request(app)
        .post(`/api/v1/bookings/${aliceBookingId}/payment`)
        .set('Authorization', 'Bearer token-alice')
        .send({ discount: 500 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/not allowed/i);
    });

    it('rejects client attempting to inject currency: { currency: "USD" } with 400 Bad Request', async () => {
      const res = await request(app)
        .post(`/api/v1/bookings/${aliceBookingId}/payment`)
        .set('Authorization', 'Bearer token-alice')
        .send({ currency: 'USD' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects client attempting to inject status: { status: "SUCCESS" } with 400 Bad Request', async () => {
      const res = await request(app)
        .post(`/api/v1/bookings/${aliceBookingId}/payment`)
        .set('Authorization', 'Bearer token-alice')
        .send({ status: 'SUCCESS' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('strictly calculates payment order amount from database pricing (500.00 rental; 1000.00 pickup deposit excluded), never from client', async () => {
      const res = await request(app)
        .post(`/api/v1/bookings/${aliceBookingId}/payment`)
        .set('Authorization', 'Bearer token-alice')
        .send({});

      // Online advance excludes the separately-collected security deposit
      // (PaymentService.initiatePayment step 5; PricingService payableAmount).
      expect(res.status).toBe(201);
      expect(res.body.data.payment.amount).toBe(500.00);
      expect(res.body.data.payment.currency).toBe('INR');

      // Check DB
      const payRow = db.public.one(`SELECT * FROM payments WHERE booking_id = '${aliceBookingId}'`);
      expect(Number(payRow.amount)).toBe(500.00);
      expect(payRow.currency).toBe('INR');
    });
  });

  describe('2. Horizontal Privilege Escalation (IDOR / BOLA)', () => {
    it('prevents Customer Alice from initiating payment on Bob booking (404 NOT_FOUND)', async () => {
      const res = await request(app)
        .post(`/api/v1/bookings/${bobBookingId}/payment`)
        .set('Authorization', 'Bearer token-alice')
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('BOOKING_NOT_FOUND');
    });

    it('prevents Customer Alice from querying payment status of Bob booking (404 NOT_FOUND)', async () => {
      const res = await request(app)
        .get(`/api/v1/bookings/${bobBookingId}/payment`)
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('BOOKING_NOT_FOUND');
    });
  });

  describe('3. Terminal State Enforcement', () => {
    it('rejects initiating payment for already completed / paid booking (400 PAYMENT_ALREADY_COMPLETED)', async () => {
      const res = await request(app)
        .post(`/api/v1/bookings/${paidBookingId}/payment`)
        .set('Authorization', 'Bearer token-alice')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('PAYMENT_ALREADY_COMPLETED');
    });
  });

  describe('4. Webhook Cryptographic Integrity & Replay Mitigation', () => {
    it('rejects webhook with forged signature even if payload is valid', async () => {
      const payload = {
        data: {
          order: { order_id: 'cf_sec_paid_123' },
          payment: { payment_status: 'SUCCESS', payment_amount: 1500, payment_currency: 'INR' },
        },
      };
      const rawBody = JSON.stringify(payload);
      const headers = signPayload(rawBody, String(Date.now()), 'attacker_wrong_secret');

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree')
        .set(headers)
        .send(rawBody);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });

    it('rejects webhook with future timestamp > 5 minutes (prevent clock manipulation attack)', async () => {
      const payload = {
        data: {
          order: { order_id: 'cf_sec_paid_123' },
          payment: { payment_status: 'SUCCESS', payment_amount: 1500, payment_currency: 'INR' },
        },
      };
      const rawBody = JSON.stringify(payload);
      const futureTimestamp = String(Date.now() + 10 * 60 * 1000); // 10 minutes in future
      const headers = signPayload(rawBody, futureTimestamp);

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree')
        .set(headers)
        .send(rawBody);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });
  });

  describe('5. SQL Injection Resilience', () => {
    it('safely handles SQL injection attack payload in bookingId parameter', async () => {
      const maliciousBookingId = "10101010-1010-4010-8010-101010101010' OR '1'='1";
      const res = await request(app)
        .post(`/api/v1/bookings/${encodeURIComponent(maliciousBookingId)}/payment`)
        .set('Authorization', 'Bearer token-alice')
        .send({});

      // Should be rejected by UUID validation (400) or not found (404), never 500 SQL syntax error
      expect([400, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
    });
  });

  describe('6. Concurrency Resilience', () => {
    it('concurrent payment initiation calls for same booking reuse the same payment record', async () => {
      const [res1, res2] = await Promise.all([
        request(app)
          .post(`/api/v1/bookings/${aliceBookingId}/payment`)
          .set('Authorization', 'Bearer token-alice')
          .send({}),
        request(app)
          .post(`/api/v1/bookings/${aliceBookingId}/payment`)
          .set('Authorization', 'Bearer token-alice')
          .send({}),
      ]);

      expect([200, 201]).toContain(res1.status);
      expect([200, 201]).toContain(res2.status);

      // Both should reference the same order ID
      expect(res1.body.data.payment.providerOrderId).toBe(res2.body.data.payment.providerOrderId);

      // In DB, only 1 payment record should exist for aliceBookingId
      const payRows = db.public.many(`SELECT * FROM payments WHERE booking_id = '${aliceBookingId}'`);
      expect(payRows.length).toBe(1);
    });
  });
});
