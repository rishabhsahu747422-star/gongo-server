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

describe('Payments Integration Tests — Phase 10', () => {
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

  const aliceBookingId = '77777777-7777-4777-8777-777777777777';
  const bobBookingId = '88888888-8888-4888-8888-888888888888';
  const cancelledBookingId = '99999999-9999-4999-8999-999999999999';
  const paidBookingId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const unpaidBookingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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
      createOrder: jest.fn().mockImplementation(async ({ orderId }) => ({
        providerOrderId: orderId,
        paymentSessionId: `session_${orderId}`,
        orderStatus: 'ACTIVE',
        cfOrderId: 'cf_12345678',
      })),
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
      VALUES ('${partnerId}', '${partnerUser.id}', 'Super Fast Rentals', 'approved', true);

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

      -- Alice's standard PENDING booking
      INSERT INTO bookings (
        id, customer_id, vehicle_id, status, rental_type,
        start_at, end_at, base_amount, security_deposit, total_amount
      ) VALUES (
        '${aliceBookingId}', '${customerAlice.id}', '${vehicleId}', 'PENDING', 'DAILY',
        '${relDate('2026-11-10T10:00:00Z')}', '${relDate('2026-11-11T10:00:00Z')}', 700.00, 2000.00, 2700.00
      );

      -- Bob's booking
      INSERT INTO bookings (
        id, customer_id, vehicle_id, status, rental_type,
        start_at, end_at, base_amount, security_deposit, total_amount
      ) VALUES (
        '${bobBookingId}', '${customerBob.id}', '${vehicleId}', 'PENDING', 'DAILY',
        '${relDate('2026-11-12T10:00:00Z')}', '${relDate('2026-11-13T10:00:00Z')}', 700.00, 2000.00, 2700.00
      );

      -- Cancelled booking
      INSERT INTO bookings (
        id, customer_id, vehicle_id, status, rental_type,
        start_at, end_at, base_amount, security_deposit, total_amount,
        cancellation_reason, cancelled_at
      ) VALUES (
        '${cancelledBookingId}', '${customerAlice.id}', '${vehicleId}', 'CANCELLED', 'DAILY',
        '${relDate('2026-11-14T10:00:00Z')}', '${relDate('2026-11-15T10:00:00Z')}', 700.00, 2000.00, 2700.00,
        'Changed plans', '${relDate('2026-11-01T10:00:00Z')}'
      );

      -- Already paid booking
      INSERT INTO bookings (
        id, customer_id, vehicle_id, status, rental_type,
        start_at, end_at, base_amount, security_deposit, total_amount
      ) VALUES (
        '${paidBookingId}', '${customerAlice.id}', '${vehicleId}', 'PAYMENT_COMPLETED', 'DAILY',
        '${relDate('2026-11-16T10:00:00Z')}', '${relDate('2026-11-17T10:00:00Z')}', 700.00, 2000.00, 2700.00
      );

      -- Unpaid booking with no payment initiated
      INSERT INTO bookings (
        id, customer_id, vehicle_id, status, rental_type,
        start_at, end_at, base_amount, security_deposit, total_amount
      ) VALUES (
        '${unpaidBookingId}', '${customerAlice.id}', '${vehicleId}', 'PENDING', 'DAILY',
        '${relDate('2026-11-18T10:00:00Z')}', '${relDate('2026-11-19T10:00:00Z')}', 700.00, 2000.00, 2700.00
      );

      -- Seed existing SUCCESS payment record for paidBookingId
      INSERT INTO payments (
        booking_id, customer_id, provider, provider_order_id,
        provider_payment_id, amount, currency, status
      ) VALUES (
        '${paidBookingId}', '${customerAlice.id}', 'CASHFREE', 'cf_paid_order_123',
        'cf_pay_999', 2700.00, 'INR', 'SUCCESS'
      );
    `);

    const adapter = db.adapters.createPg();
    mockPool = new adapter.Pool();
    pool.query = mockPool.query.bind(mockPool);
    pool.connect = mockPool.connect.bind(mockPool);

    app = createApp();
  });

  afterAll(() => {
    cashfreeProvider.setMockDelegate(null);
  });

  describe('POST /api/v1/bookings/:bookingId/payment', () => {
    it('1. authenticated customer can initiate payment for their booking with status 201', async () => {
      const res = await request(app)
        .post(`/api/v1/bookings/${aliceBookingId}/payment`)
        .set('Authorization', 'Bearer token-alice')
        .send({});

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);

      const { payment } = res.body.data;
      expect(payment).toBeDefined();
      expect(payment.bookingId).toBe(aliceBookingId);
      expect(payment.customerId).toBe(customerAlice.id);
      expect(payment.provider).toBe('CASHFREE');
      expect(payment.providerOrderId).toBeDefined();
      // Online advance = rental subtotal from the booking pricing snapshot (700). The 2000
      // security deposit is collected separately at pickup and is excluded
      // (PaymentService.initiatePayment step 5; PricingService payableAmount).
      expect(payment.amount).toBe(700.00);
      expect(payment.currency).toBe('INR');
      expect(payment.status).toBe('PENDING');
      expect(payment.paymentSessionId).toBeDefined();

      // Verify booking status was updated to PAYMENT_PENDING in database
      const bookingRow = db.public.one(`SELECT status FROM bookings WHERE id = '${aliceBookingId}'`);
      expect(bookingRow.status).toBe('PAYMENT_PENDING');
    });

    it('2. re-requesting payment returns existing active payment order (idempotent, status 200)', async () => {
      const res = await request(app)
        .post(`/api/v1/bookings/${aliceBookingId}/payment`)
        .set('Authorization', 'Bearer token-alice')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.payment.bookingId).toBe(aliceBookingId);
      expect(res.body.data.payment.status).toBe('PENDING');
    });

    it('3. supports Idempotency-Key header on repeated request', async () => {
      const idempotencyKey = 'idem-pay-alice-123';

      const res1 = await request(app)
        .post(`/api/v1/bookings/${unpaidBookingId}/payment`)
        .set('Authorization', 'Bearer token-alice')
        .set('Idempotency-Key', idempotencyKey)
        .send({});

      expect(res1.status).toBe(201);
      const originalOrderId = res1.body.data.payment.providerOrderId;

      // Second call with same idempotency key
      const res2 = await request(app)
        .post(`/api/v1/bookings/${unpaidBookingId}/payment`)
        .set('Authorization', 'Bearer token-alice')
        .set('Idempotency-Key', idempotencyKey)
        .send({});

      expect(res2.status).toBe(200);
      expect(res2.body.data.payment.providerOrderId).toBe(originalOrderId);
    });

    it('4. rejects unauthenticated request with 401', async () => {
      const res = await request(app)
        .post(`/api/v1/bookings/${aliceBookingId}/payment`)
        .send({});

      expect(res.status).toBe(401);
    });

    it('5. rejects non-customer role with 403', async () => {
      const res = await request(app)
        .post(`/api/v1/bookings/${aliceBookingId}/payment`)
        .set('Authorization', 'Bearer token-partner')
        .send({});

      expect(res.status).toBe(403);
    });

    it('6. prevents Customer Alice from paying for Customer Bob booking (404 / IDOR)', async () => {
      const res = await request(app)
        .post(`/api/v1/bookings/${bobBookingId}/payment`)
        .set('Authorization', 'Bearer token-alice')
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('BOOKING_NOT_FOUND');
    });

    it('7. rejects payment for cancelled booking with 400 BOOKING_NOT_PAYABLE', async () => {
      const res = await request(app)
        .post(`/api/v1/bookings/${cancelledBookingId}/payment`)
        .set('Authorization', 'Bearer token-alice')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BOOKING_NOT_PAYABLE');
    });

    it('8. rejects payment for already paid booking with 400 PAYMENT_ALREADY_COMPLETED', async () => {
      const res = await request(app)
        .post(`/api/v1/bookings/${paidBookingId}/payment`)
        .set('Authorization', 'Bearer token-alice')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PAYMENT_ALREADY_COMPLETED');
    });
  });

  describe('GET /api/v1/bookings/:bookingId/payment', () => {
    it('9. owner customer can retrieve payment status for their booking', async () => {
      const res = await request(app)
        .get(`/api/v1/bookings/${aliceBookingId}/payment`)
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const { payment } = res.body.data;
      expect(payment.bookingId).toBe(aliceBookingId);
      expect(payment.provider).toBe('CASHFREE');
      expect(payment.status).toBe('PENDING');
      expect(payment.isPaid).toBe(false);
    });

    it('10. returns NO_PAYMENT_INITIATED for booking with no payment attempts', async () => {
      const tempBookingId = crypto.randomUUID();
      db.public.none(`
        INSERT INTO bookings (
          id, customer_id, vehicle_id, status, rental_type,
          start_at, end_at, base_amount, security_deposit, total_amount
        ) VALUES (
          '${tempBookingId}', '${customerBob.id}', '${vehicleId}', 'PENDING', 'DAILY',
          '${relDate('2026-12-01T10:00:00Z')}', '${relDate('2026-12-02T10:00:00Z')}', 700.00, 2000.00, 2700.00
        );
      `);

      const res = await request(app)
        .get(`/api/v1/bookings/${tempBookingId}/payment`)
        .set('Authorization', 'Bearer token-bob');

      expect(res.status).toBe(200);
      expect(res.body.data.payment.status).toBe('NO_PAYMENT_INITIATED');
      expect(res.body.data.payment.isPaid).toBe(false);
    });

    it('11. Customer Alice cannot view payment status of Customer Bob booking (404 / IDOR)', async () => {
      const res = await request(app)
        .get(`/api/v1/bookings/${bobBookingId}/payment`)
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('BOOKING_NOT_FOUND');
    });

    it('12. unauthenticated request rejected with 401', async () => {
      const res = await request(app)
        .get(`/api/v1/bookings/${aliceBookingId}/payment`);

      expect(res.status).toBe(401);
    });
  });
});
