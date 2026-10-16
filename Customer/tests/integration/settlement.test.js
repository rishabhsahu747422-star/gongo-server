'use strict';

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
const returnVerificationsMigration = require('../../database/migrations/1728000000000_create-booking-return-verifications-table');
const addPaymentTypeMigration = require('../../database/migrations/1728100000000_add-payment-type-to-payments');

describe('Post-Rental Settlement Payments Integration Tests', () => {
  let app;
  let db;
  let mockPool;

  const SECRET_KEY = process.env.CASHFREE_SECRET_KEY || 'test_cf_secret_key';

  const customerAlice = {
    id: '11111111-1111-4111-8111-111111111111',
    role: 'customer',
    name: 'Alice Customer',
    countryCode: '+91',
    phone: '9871110001',
    email: 'alice@example.com',
    authId: 'auth-uid-alice',
  };

  const customerBob = {
    id: '22222222-2222-4222-8222-222222222222',
    role: 'customer',
    name: 'Bob Customer',
    countryCode: '+91',
    phone: '9871110002',
    email: 'bob@example.com',
    authId: 'auth-uid-bob',
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

  // Booking IDs
  const completedBookingAlice = '77777777-7777-4777-8777-777777777771';
  const completedZeroDuesAlice = '77777777-7777-4777-8777-777777777772';
  const activeBookingAlice = '77777777-7777-4777-8777-777777777773';
  const completedBookingBob = '88888888-8888-4888-8888-888888888881';
  const advanceBookingAlice = '77777777-7777-4777-8777-777777777774';

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
    await returnVerificationsMigration.up(pgm);
    await addPaymentTypeMigration.up(pgm);

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
      createOrder: jest.fn().mockImplementation(async ({ orderId, orderAmount }) => ({
        providerOrderId: orderId,
        paymentSessionId: `session_${orderId}`,
        orderStatus: 'ACTIVE',
        cfOrderId: 'cf_12345678',
        orderAmount,
      })),
      getOrderStatus: jest.fn().mockResolvedValue({
        orderStatus: 'ACTIVE',
      }),
    });

    // Seed users
    db.public.none(`
      INSERT INTO users (id, role, name, country_code, phone, email, auth_provider, auth_id, is_active)
      VALUES
        ('${customerAlice.id}', 'customer', '${customerAlice.name}', '${customerAlice.countryCode}', '${customerAlice.phone}', '${customerAlice.email}', 'firebase', '${customerAlice.authId}', true),
        ('${customerBob.id}', 'customer', '${customerBob.name}', '${customerBob.countryCode}', '${customerBob.phone}', '${customerBob.email}', 'firebase', '${customerBob.authId}', true),
        ('${partnerUser.id}', 'partner', '${partnerUser.name}', '${partnerUser.countryCode}', '${partnerUser.phone}', '${partnerUser.email}', 'firebase', '${partnerUser.authId}', true);

      INSERT INTO partners (id, user_id, business_name, verification_status, is_active)
      VALUES ('${partnerId}', '${partnerUser.id}', 'City Mobility', 'approved', true);

      INSERT INTO shops (id, partner_id, shop_name, is_active)
      VALUES ('${shopId}', '${partnerId}', 'MG Road Shop', true);
    `);

    const cat = db.public.one("SELECT id FROM vehicle_categories WHERE slug = 'bike'");
    categoryId = cat.id;

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
        'Honda Activa 6G', 'Honda', 'Activa 6G', 2023, 'KA01AB1234',
        'PETROL', 'AUTOMATIC', 2,
        50.00, 400.00, 2400.00, 8000.00,
        1000.00, 100.00, 5.00,
        'ACTIVE', 'MG Road Hub'
      );
    `);

    // Seed bookings
    db.public.none(`
      INSERT INTO bookings (
        id, customer_id, vehicle_id, status, rental_type,
        start_at, end_at, base_amount, security_deposit, total_amount
      ) VALUES
        ('${completedBookingAlice}', '${customerAlice.id}', '${vehicleId}', 'COMPLETED', 'DAILY',
         '2026-10-01T10:00:00Z', '2026-10-02T10:00:00Z', 400.00, 1000.00, 1400.00),
        ('${completedZeroDuesAlice}', '${customerAlice.id}', '${vehicleId}', 'COMPLETED', 'DAILY',
         '2026-10-03T10:00:00Z', '2026-10-04T10:00:00Z', 400.00, 1000.00, 1400.00),
        ('${activeBookingAlice}', '${customerAlice.id}', '${vehicleId}', 'IN_PROGRESS', 'DAILY',
         '2026-10-05T10:00:00Z', '2026-10-06T10:00:00Z', 400.00, 1000.00, 1400.00),
        ('${completedBookingBob}', '${customerBob.id}', '${vehicleId}', 'COMPLETED', 'DAILY',
         '2026-10-07T10:00:00Z', '2026-10-08T10:00:00Z', 400.00, 1000.00, 1400.00),
        ('${advanceBookingAlice}', '${customerAlice.id}', '${vehicleId}', 'PAYMENT_PENDING', 'DAILY',
         '2026-10-09T10:00:00Z', '2026-10-10T10:00:00Z', 400.00, 1000.00, 1400.00);
    `);

    // Seed return verifications
    db.public.none(`
      INSERT INTO booking_return_verifications (
        id, booking_id, returned_at, odometer_end, fuel_level_end,
        late_minutes, late_fee, extra_km, extra_km_fee, notes
      ) VALUES
        (gen_random_uuid(), '${completedBookingAlice}', CURRENT_TIMESTAMP, 1050.00, 'FULL', 60, 200.00, 40.00, 300.00, 'Normal wear'),
        (gen_random_uuid(), '${completedZeroDuesAlice}', CURRENT_TIMESTAMP, 1000.00, 'FULL', 0, 0.00, 0.00, 0.00, 'Returned on time'),
        (gen_random_uuid(), '${completedBookingBob}', CURRENT_TIMESTAMP, 1100.00, 'FULL', 30, 100.00, 10.00, 50.00, 'Bob return');
    `);

    const adapter = db.adapters.createPg();
    mockPool = new adapter.Pool();
    pool.query = mockPool.query.bind(mockPool);
    pool.connect = mockPool.connect.bind(mockPool);

    app = createApp();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
  });

  describe('GET /api/v1/bookings/:bookingId/settlement', () => {
    it('1. retrieves customer-safe settlement details for completed booking with late and extra km fees', async () => {
      const res = await request(app)
        .get(`/api/v1/bookings/${completedBookingAlice}/settlement`)
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const { data } = res.body;
      expect(data.bookingId).toBe(completedBookingAlice);
      expect(data.bookingStatus).toBe('COMPLETED');
      expect(data.lateFee).toBe(200.00);
      expect(data.extraKmFee).toBe(300.00);
      expect(data.totalAmount).toBe(500.00);
      expect(data.paymentStatus).toBe('UNPAID');

      // Ensure no internal financial data is leaked
      expect(data.commission).toBeUndefined();
      expect(data.partnerEarnings).toBeUndefined();
      expect(data.payout).toBeUndefined();
      expect(data.wallet).toBeUndefined();
    });

    it('2. returns totalAmount 0 and UNPAID when no dues are payable', async () => {
      const res = await request(app)
        .get(`/api/v1/bookings/${completedZeroDuesAlice}/settlement`)
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(200);
      expect(res.body.data.totalAmount).toBe(0.00);
      expect(res.body.data.lateFee).toBe(0.00);
      expect(res.body.data.extraKmFee).toBe(0.00);
    });

    it('3. rejects unauthenticated request with 401', async () => {
      const res = await request(app)
        .get(`/api/v1/bookings/${completedBookingAlice}/settlement`);

      expect(res.status).toBe(401);
    });

    it('4. prevents Customer Alice from viewing Customer Bob settlement (BOLA / IDOR 404)', async () => {
      const res = await request(app)
        .get(`/api/v1/bookings/${completedBookingBob}/settlement`)
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('BOOKING_NOT_FOUND');
    });

    it('5. rejects settlement query when booking is not completed (e.g. IN_PROGRESS)', async () => {
      const res = await request(app)
        .get(`/api/v1/bookings/${activeBookingAlice}/settlement`)
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BOOKING_NOT_COMPLETED');
    });
  });

  describe('POST /api/v1/bookings/:bookingId/settlement/payment', () => {
    let createdSettlementPaymentId;
    let createdProviderOrderId;

    it('6. authenticated customer creates settlement payment order for completed booking with dues', async () => {
      const res = await request(app)
        .post(`/api/v1/bookings/${completedBookingAlice}/settlement/payment`)
        .set('Authorization', 'Bearer token-alice')
        .send({});

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);

      const { payment } = res.body.data;
      expect(payment.bookingId).toBe(completedBookingAlice);
      expect(payment.amount).toBe(500.00); // 200 late_fee + 300 extra_km_fee
      expect(payment.currency).toBe('INR');
      expect(payment.status).toBe('PENDING');
      expect(payment.paymentType).toBe('POST_RENTAL_SETTLEMENT');
      expect(payment.providerOrderId).toBeDefined();
      expect(payment.paymentSessionId).toBeDefined();

      createdSettlementPaymentId = payment.id;
      createdProviderOrderId = payment.providerOrderId;
    });

    it('7. re-requesting payment returns existing active payment order without duplicate creation', async () => {
      const res = await request(app)
        .post(`/api/v1/bookings/${completedBookingAlice}/settlement/payment`)
        .set('Authorization', 'Bearer token-alice')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const { payment } = res.body.data;
      expect(payment.id).toBe(createdSettlementPaymentId);
      expect(payment.providerOrderId).toBe(createdProviderOrderId);
      expect(payment.amount).toBe(500.00);
      expect(payment.paymentType).toBe('POST_RENTAL_SETTLEMENT');
    });

    it('8. supports Idempotency-Key header on repeated request', async () => {
      const idempotencyKey = crypto.randomUUID();

      const res1 = await request(app)
        .post(`/api/v1/bookings/${completedBookingAlice}/settlement/payment`)
        .set('Authorization', 'Bearer token-alice')
        .set('Idempotency-Key', idempotencyKey)
        .send({});

      expect([200, 201]).toContain(res1.status);

      const res2 = await request(app)
        .post(`/api/v1/bookings/${completedBookingAlice}/settlement/payment`)
        .set('Authorization', 'Bearer token-alice')
        .set('Idempotency-Key', idempotencyKey)
        .send({});

      expect([200, 201]).toContain(res2.status);
      expect(res2.body.data.payment.id).toBe(res1.body.data.payment.id);
    });

    it('9. strictly rejects client attempting to inject amount, lateFee, or status', async () => {
      const tamperPayloads = [
        { amount: 10 },
        { lateFee: 0 },
        { extraKmFee: 0 },
        { total: 50 },
        { status: 'SUCCESS' },
        { paymentStatus: 'PAID' },
      ];

      for (let i = 0; i < tamperPayloads.length; i += 1) {
        const payload = tamperPayloads[i];
        const res = await request(app)
          .post(`/api/v1/bookings/${completedBookingAlice}/settlement/payment`)
          .set('Authorization', 'Bearer token-alice')
          .send(payload);

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
      }
    });

    it('10. rejects with NO_SETTLEMENT_CHARGES_PAYABLE when booking has zero post-rental dues', async () => {
      const res = await request(app)
        .post(`/api/v1/bookings/${completedZeroDuesAlice}/settlement/payment`)
        .set('Authorization', 'Bearer token-alice')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('NO_SETTLEMENT_CHARGES_PAYABLE');
    });

    it('11. prevents Customer Alice from creating payment on Customer Bob booking (404 IDOR)', async () => {
      const res = await request(app)
        .post(`/api/v1/bookings/${completedBookingBob}/settlement/payment`)
        .set('Authorization', 'Bearer token-alice')
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('BOOKING_NOT_FOUND');
    });

    it('12. rejects payment initiation when booking is not completed', async () => {
      const res = await request(app)
        .post(`/api/v1/bookings/${activeBookingAlice}/settlement/payment`)
        .set('Authorization', 'Bearer token-alice')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BOOKING_NOT_COMPLETED');
    });
  });

  describe('Cashfree Webhook Processing with POST_RENTAL_SETTLEMENT', () => {
    it('13. processes successful settlement webhook, marks payment SUCCESS, and leaves booking COMPLETED', async () => {
      // Find the payment record created for completedBookingAlice
      const paymentRow = db.public.one(`
        SELECT * FROM payments
        WHERE booking_id = '${completedBookingAlice}'
          AND payment_type = 'POST_RENTAL_SETTLEMENT'
        ORDER BY created_at DESC LIMIT 1
      `);

      const webhookPayload = {
        data: {
          order: {
            order_id: paymentRow.provider_order_id,
            order_amount: 500.00,
            order_currency: 'INR',
          },
          payment: {
            cf_payment_id: 'cf_pay_settle_999',
            payment_status: 'SUCCESS',
            payment_amount: 500.00,
            payment_currency: 'INR',
            payment_method: 'UPI',
          },
        },
        event_time: new Date().toISOString(),
        type: 'PAYMENT_SUCCESS_WEBHOOK',
      };

      const rawBody = JSON.stringify(webhookPayload);
      const headers = signPayload(rawBody);

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree')
        .set(headers)
        .send(rawBody);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify payment status updated to SUCCESS in DB
      const updatedPayment = db.public.one(`
        SELECT * FROM payments WHERE id = '${paymentRow.id}'
      `);
      expect(updatedPayment.status).toBe('paid'); // PAYMENT_STATUS.SUCCESS = 'paid' (src/constants/payment.js)
      expect(updatedPayment.provider_payment_id).toBe('cf_pay_settle_999');

      // CRITICAL: Verify booking status REMAINS COMPLETED
      const booking = db.public.one(`
        SELECT status FROM bookings WHERE id = '${completedBookingAlice}'
      `);
      expect(booking.status).toBe('COMPLETED');
    });

    it('14. GET settlement now reflects paymentStatus = PAID', async () => {
      const res = await request(app)
        .get(`/api/v1/bookings/${completedBookingAlice}/settlement`)
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(200);
      expect(res.body.data.paymentStatus).toBe('PAID');
    });

    it('15. attempting to initiate settlement payment when already paid returns 409 SETTLEMENT_ALREADY_PAID', async () => {
      const res = await request(app)
        .post(`/api/v1/bookings/${completedBookingAlice}/settlement/payment`)
        .set('Authorization', 'Bearer token-alice')
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SETTLEMENT_ALREADY_PAID');
    });

    it('16. regression: BOOKING_ADVANCE payment webhook updates booking to PAYMENT_COMPLETED', async () => {
      // Create advance payment for advanceBookingAlice
      const advanceProviderOrderId = 'cf_order_advance_reg_1';
      db.public.none(`
        INSERT INTO payments (
          id, booking_id, customer_id, provider, provider_order_id,
          amount, currency, status, payment_type
        ) VALUES (
          gen_random_uuid(), '${advanceBookingAlice}', '${customerAlice.id}',
          'CASHFREE', '${advanceProviderOrderId}', 1400.00, 'INR', 'PENDING', 'BOOKING_ADVANCE'
        );
      `);

      const webhookPayload = {
        data: {
          order: {
            order_id: advanceProviderOrderId,
            order_amount: 1400.00,
            order_currency: 'INR',
          },
          payment: {
            cf_payment_id: 'cf_pay_adv_888',
            payment_status: 'SUCCESS',
            payment_amount: 1400.00,
            payment_currency: 'INR',
            payment_method: 'NETBANKING',
          },
        },
        type: 'PAYMENT_SUCCESS_WEBHOOK',
      };

      const rawBody = JSON.stringify(webhookPayload);
      const headers = signPayload(rawBody);

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree')
        .set(headers)
        .send(rawBody);

      expect(res.status).toBe(200);

      // Verify booking updated to PAYMENT_COMPLETED
      const booking = db.public.one(`
        SELECT status FROM bookings WHERE id = '${advanceBookingAlice}'
      `);
      expect(booking.status).toBe('payment_completed'); // BOOKING_STATUS.PAYMENT_COMPLETED (src/constants/booking.js)
    });

    it('17. webhook amount mismatch against immutable payments.amount throws 400 and fails payment', async () => {
      const mismatchOrderId = 'cf_order_settle_mismatch';
      const mismatchPaymentId = crypto.randomUUID();
      db.public.none(`
        INSERT INTO payments (
          id, booking_id, customer_id, provider, provider_order_id,
          amount, currency, status, payment_type
        ) VALUES (
          '${mismatchPaymentId}', '${completedBookingBob}', '${customerBob.id}',
          'CASHFREE', '${mismatchOrderId}', 150.00, 'INR', 'PENDING', 'POST_RENTAL_SETTLEMENT'
        );
      `);

      // Webhook payload sends amount 250.00 instead of authoritative 150.00
      const webhookPayload = {
        data: {
          order: {
            order_id: mismatchOrderId,
            order_amount: 250.00,
          },
          payment: {
            cf_payment_id: 'cf_pay_tampered',
            payment_status: 'SUCCESS',
            payment_amount: 250.00,
          },
        },
        type: 'PAYMENT_SUCCESS_WEBHOOK',
      };

      const rawBody = JSON.stringify(webhookPayload);
      const headers = signPayload(rawBody);

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree')
        .set(headers)
        .send(rawBody);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PAYMENT_AMOUNT_MISMATCH');

      const failedPayment = db.public.one(`
        SELECT status, failure_reason FROM payments WHERE id = '${mismatchPaymentId}'
      `);
      expect(failedPayment.status).toBe('failed'); // PAYMENT_STATUS.FAILED (src/constants/payment.js)
      expect(failedPayment.failure_reason).toBe('AMOUNT_MISMATCH');
    });
  });
});
