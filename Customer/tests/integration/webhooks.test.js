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
const { createApp } = require('../../src/app');
const { BOOKING_STATUS } = require('../../src/constants/booking');
const { PAYMENT_STATUS } = require('../../src/constants/payment');

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

describe('Cashfree Webhook Integration Tests — Phase 10', () => {
  let app;
  let db;
  let mockPool;

  const SECRET_KEY = process.env.CASHFREE_SECRET_KEY || 'test_cf_secret_key';

  const customerId = '11111111-1111-4111-8111-111111111111';
  const partnerUserId = '33333333-3333-4333-8333-333333333333';
  const partnerId = '44444444-4444-4444-8444-444444444444';
  const shopId = '55555555-5555-4555-8555-555555555555';
  let categoryId;
  const vehicleId = '66666666-6666-4666-8666-666666666666';

  const bookingId = '77777777-7777-4777-8777-777777777777';
  const paymentId = '88888888-8888-4888-8888-888888888888';
  const providerOrderId = 'cf_order_webhook_test_001';

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

    // Seed users
    db.public.none(`
      INSERT INTO users (id, role, name, country_code, phone, email, auth_provider, auth_id, is_active)
      VALUES
        ('${customerId}', 'customer', 'Alice Customer', '+91', '9871110001', 'alice@example.com', 'firebase', 'auth-uid-alice', true),
        ('${partnerUserId}', 'partner', 'Partner User', '+91', '9871110003', 'partner@example.com', 'firebase', 'auth-uid-partner', true);

      INSERT INTO partners (id, user_id, business_name, verification_status, is_active)
      VALUES ('${partnerId}', '${partnerUserId}', 'Super Fast Rentals', 'approved', true);

      INSERT INTO shops (id, partner_id, shop_name, is_active)
      VALUES ('${shopId}', '${partnerId}', 'Central Shop', true);
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
        80.00, 700.00, 4200.00, 15000.00, 2000.00, 100.00, 10.00, 'ACTIVE', 'Indiranagar Hub'
      );
    `);

    const adapter = db.adapters.createPg();
    mockPool = new adapter.Pool();
    pool.query = mockPool.query.bind(mockPool);
    pool.connect = mockPool.connect.bind(mockPool);

    app = createApp();
  });

  beforeEach(async () => {
    // Reset booking & payment records
    db.public.none('DELETE FROM payments');
    db.public.none('DELETE FROM bookings');

    // Seed booking
    db.public.none(`
      INSERT INTO bookings (
        id, customer_id, vehicle_id, status, rental_type,
        start_at, end_at, base_amount, security_deposit, total_amount
      ) VALUES (
        '${bookingId}', '${customerId}', '${vehicleId}', '${BOOKING_STATUS.PAYMENT_PENDING}', 'DAILY',
        '${relDate('2026-11-10T10:00:00Z')}', '${relDate('2026-11-11T10:00:00Z')}', 700.00, 2000.00, 2700.00
      );

      INSERT INTO payments (
        id, booking_id, customer_id, provider, provider_order_id,
        amount, currency, status
      ) VALUES (
        '${paymentId}', '${bookingId}', '${customerId}', 'CASHFREE', '${providerOrderId}',
        2700.00, 'INR', 'CREATED'
      );
    `);
  });

  describe('Webhook Signature & Security', () => {
    it('1. rejects webhook with missing signature headers with 400 INVALID_WEBHOOK_SIGNATURE', async () => {
      const payload = {
        data: {
          order: { order_id: providerOrderId },
          payment: { payment_status: 'SUCCESS', payment_amount: 2700, payment_currency: 'INR' },
        },
      };

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree')
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });

    it('2. rejects webhook with forged / invalid signature with 400 INVALID_WEBHOOK_SIGNATURE', async () => {
      const payload = {
        data: {
          order: { order_id: providerOrderId },
          payment: { payment_status: 'SUCCESS', payment_amount: 2700, payment_currency: 'INR' },
        },
      };
      const rawBody = JSON.stringify(payload);
      const headers = signPayload(rawBody, String(Date.now()), 'forged_secret_key');

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree')
        .set(headers)
        .send(rawBody);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });

    it('3. rejects webhook with expired timestamp (replay prevention > 10 min)', async () => {
      const payload = {
        data: {
          order: { order_id: providerOrderId },
          payment: { payment_status: 'SUCCESS', payment_amount: 2700, payment_currency: 'INR' },
        },
      };
      const rawBody = JSON.stringify(payload);
      const expiredTimestamp = String(Date.now() - 15 * 60 * 1000);
      const headers = signPayload(rawBody, expiredTimestamp);

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree')
        .set(headers)
        .send(rawBody);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });
  });

  describe('Payment Reconciliation & Status Transition', () => {
    it('4. marks payment SUCCESS and booking PAYMENT_COMPLETED on valid SUCCESS event', async () => {
      const payload = {
        data: {
          order: { order_id: providerOrderId, order_amount: 2700, order_currency: 'INR' },
          payment: {
            cf_payment_id: 'cf_pay_success_123',
            payment_status: 'SUCCESS',
            payment_amount: 2700,
            payment_currency: 'INR',
            payment_method: 'UPI',
          },
        },
      };
      const rawBody = JSON.stringify(payload);
      const headers = signPayload(rawBody);

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree')
        .set(headers)
        .send(rawBody);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe(PAYMENT_STATUS.SUCCESS);

      // Verify DB state
      const payRow = db.public.one(`SELECT * FROM payments WHERE id = '${paymentId}'`);
      expect(payRow.status).toBe(PAYMENT_STATUS.SUCCESS);
      expect(payRow.provider_payment_id).toBe('cf_pay_success_123');
      expect(payRow.payment_method).toBe('UPI');

      const bookRow = db.public.one(`SELECT * FROM bookings WHERE id = '${bookingId}'`);
      expect(bookRow.status).toBe(BOOKING_STATUS.PAYMENT_COMPLETED);
    });

    it('5. duplicate SUCCESS webhook replay is idempotent and returns 200 without error', async () => {
      const payload = {
        data: {
          order: { order_id: providerOrderId, order_amount: 2700 },
          payment: {
            cf_payment_id: 'cf_pay_success_123',
            payment_status: 'SUCCESS',
            payment_amount: 2700,
            payment_currency: 'INR',
          },
        },
      };
      const rawBody = JSON.stringify(payload);
      const headers = signPayload(rawBody);

      // First webhook
      const firstRes = await request(app)
        .post('/api/v1/payments/webhook/cashfree')
        .set(headers)
        .send(rawBody);
      expect(firstRes.status).toBe(200);

      // Duplicate delivery
      const replayHeaders = signPayload(rawBody);
      const replayRes = await request(app)
        .post('/api/v1/payments/webhook/cashfree')
        .set(replayHeaders)
        .send(rawBody);

      expect(replayRes.status).toBe(200);
      expect(replayRes.body.success).toBe(true);
      expect(replayRes.body.data.alreadyProcessed).toBe(true);
    });

    it('6. marks payment FAILED on FAILED webhook and transitions booking to CANCELLED', async () => {
      const payload = {
        data: {
          order: { order_id: providerOrderId },
          payment: {
            cf_payment_id: 'cf_pay_failed_456',
            payment_status: 'FAILED',
            payment_message: 'Insufficient balance',
          },
        },
      };
      const rawBody = JSON.stringify(payload);
      const headers = signPayload(rawBody);

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree')
        .set(headers)
        .send(rawBody);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe(PAYMENT_STATUS.FAILED);

      const payRow = db.public.one(`SELECT * FROM payments WHERE id = '${paymentId}'`);
      expect(payRow.status).toBe(PAYMENT_STATUS.FAILED);
      expect(payRow.failure_reason).toBe('Insufficient balance');

      const bookRow = db.public.one(`SELECT * FROM bookings WHERE id = '${bookingId}'`);
      expect(bookRow.status).toBe(BOOKING_STATUS.CANCELLED);
    });

    it('7. detects amount tampering in webhook: rejects with 400 and marks payment FAILED', async () => {
      const payload = {
        data: {
          order: { order_id: providerOrderId },
          payment: {
            cf_payment_id: 'cf_tampered_amount',
            payment_status: 'SUCCESS',
            payment_amount: 100, // Attacker paid 100 instead of 2700!
            payment_currency: 'INR',
          },
        },
      };
      const rawBody = JSON.stringify(payload);
      const headers = signPayload(rawBody);

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree')
        .set(headers)
        .send(rawBody);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('PAYMENT_AMOUNT_MISMATCH');

      const payRow = db.public.one(`SELECT * FROM payments WHERE id = '${paymentId}'`);
      expect(payRow.status).toBe(PAYMENT_STATUS.FAILED);
      expect(payRow.failure_reason).toBe('AMOUNT_MISMATCH');

      const bookRow = db.public.one(`SELECT * FROM bookings WHERE id = '${bookingId}'`);
      expect(bookRow.status).not.toBe(BOOKING_STATUS.PAYMENT_COMPLETED);
    });

    it('8. detects currency tampering in webhook: rejects with 400 and marks payment FAILED', async () => {
      const payload = {
        data: {
          order: { order_id: providerOrderId },
          payment: {
            cf_payment_id: 'cf_tampered_curr',
            payment_status: 'SUCCESS',
            payment_amount: 2700,
            payment_currency: 'USD', // Spoofed currency
          },
        },
      };
      const rawBody = JSON.stringify(payload);
      const headers = signPayload(rawBody);

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree')
        .set(headers)
        .send(rawBody);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('PAYMENT_CURRENCY_MISMATCH');

      const payRow = db.public.one(`SELECT * FROM payments WHERE id = '${paymentId}'`);
      expect(payRow.status).toBe(PAYMENT_STATUS.FAILED);
      expect(payRow.failure_reason).toBe('CURRENCY_MISMATCH');
    });

    it('9. gracefully returns 200 PAYMENT_NOT_FOUND for unknown order_id', async () => {
      const payload = {
        data: {
          order: { order_id: 'unknown_order_99999' },
          payment: {
            payment_status: 'SUCCESS',
            payment_amount: 500,
            payment_currency: 'INR',
          },
        },
      };
      const rawBody = JSON.stringify(payload);
      const headers = signPayload(rawBody);

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree')
        .set(headers)
        .send(rawBody);

      expect(res.status).toBe(200);
      expect(res.body.data.processed).toBe(false);
      expect(res.body.data.reason).toBe('PAYMENT_NOT_FOUND');
    });
  });
});
