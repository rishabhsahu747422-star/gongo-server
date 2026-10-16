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
const firebaseProvider = require('../../src/services/notification/providers/firebase.provider');
const cashfreeProvider = require('../../src/services/payment/providers/cashfree.provider');
const bookingService = require('../../src/services/booking.service');
const paymentService = require('../../src/services/payment.service');

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
const deviceTokensMigration = require('../../database/migrations/1727500000000_create-customer-device-tokens-table');
const notificationsMigration = require('../../database/migrations/1727600000000_create-notifications-table');

describe('Notifications Integration Tests — Phase 11', () => {
  let app;
  let db;
  let mockPool;

  const SECRET_KEY = process.env.CASHFREE_SECRET_KEY || 'test_cf_secret_key';

  const customerAlice = {
    id: '11111111-1111-4111-8111-111111111111',
    role: 'customer',
    name: 'Alice Notifications',
    countryCode: '+91',
    phone: '9870000001',
    email: 'alice.notif@example.com',
    authId: 'auth-alice-notif',
  };

  const customerBob = {
    id: '22222222-2222-4222-8222-222222222222',
    role: 'customer',
    name: 'Bob Notifications',
    countryCode: '+91',
    phone: '9870000002',
    email: 'bob.notif@example.com',
    authId: 'auth-bob-notif',
  };

  const partnerUser = {
    id: '33333333-3333-4333-8333-333333333333',
    role: 'partner',
    name: 'Partner User',
    countryCode: '+91',
    phone: '9870000003',
    email: 'partner.notif@example.com',
    authId: 'auth-partner-notif',
  };

  const partnerId = '44444444-4444-4444-8444-444444444444';
  const shopId = '55555555-5555-4555-8555-555555555555';
  let categoryId;
  const vehicleId = '66666666-6666-4666-8666-666666666666';

  let mockFCM;

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
    await deviceTokensMigration.up(pgm);
    await notificationsMigration.up(pgm);

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
      VALUES ('${partnerId}', '${partnerUser.id}', 'Fast Rentals', 'approved', true);

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

  beforeEach(() => {
    db.public.none('DELETE FROM notifications');
    db.public.none('DELETE FROM customer_device_tokens');
    db.public.none('DELETE FROM payments');
    db.public.none('DELETE FROM bookings');

    mockFCM = {
      sendMulticast: jest.fn().mockResolvedValue({
        successCount: 1,
        failureCount: 0,
        invalidTokens: [],
      }),
    };
    firebaseProvider.setMockDelegate(mockFCM);
  });

  afterAll(() => {
    firebaseProvider.setMockDelegate(null);
    cashfreeProvider.setMockDelegate(null);
  });

  describe('Customer Notifications Retrieval & Read APIs', () => {
    let aliceNotif1Id;
    let aliceNotif2Id;
    let bobNotifId;

    beforeEach(() => {
      // Seed notifications
      db.public.none(`
        INSERT INTO notifications (id, customer_id, type, title, body, status, created_at)
        VALUES
          ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${customerAlice.id}', 'BOOKING_CREATED', 'Booking 1', 'Created first', 'SENT', '2026-10-01T10:00:00Z'),
          ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '${customerAlice.id}', 'PAYMENT_SUCCESS', 'Payment Success', 'Paid second', 'SENT', '2026-10-02T10:00:00Z'),
          ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '${customerBob.id}', 'BOOKING_CREATED', 'Bob Booking', 'Bob created', 'SENT', '2026-10-03T10:00:00Z');
      `);

      aliceNotif1Id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      aliceNotif2Id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      bobNotifId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    });

    it('1. lists notifications in descending chronological order (newest first)', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me/notifications')
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.notifications.length).toBe(2);
      // Newest first (aliceNotif2 is Oct 2, aliceNotif1 is Oct 1)
      expect(res.body.data.notifications[0].id).toBe(aliceNotif2Id);
      expect(res.body.data.notifications[1].id).toBe(aliceNotif1Id);
    });

    it('2. returns correct unread count and filters by unreadOnly=true', async () => {
      // Mark notif1 as read
      db.public.none(`
        UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE id = '${aliceNotif1Id}'
      `);

      // Check unread count
      const countRes = await request(app)
        .get('/api/v1/customers/me/notifications/unread-count')
        .set('Authorization', 'Bearer token-alice');

      expect(countRes.status).toBe(200);
      expect(countRes.body.data.count).toBe(1);

      // Check list with unreadOnly=true
      const listRes = await request(app)
        .get('/api/v1/customers/me/notifications?unreadOnly=true')
        .set('Authorization', 'Bearer token-alice');

      expect(listRes.status).toBe(200);
      expect(listRes.body.data.notifications.length).toBe(1);
      expect(listRes.body.data.notifications[0].id).toBe(aliceNotif2Id);
    });

    it('3. retrieves a single notification belonging to the customer', async () => {
      const res = await request(app)
        .get(`/api/v1/customers/me/notifications/${aliceNotif1Id}`)
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(200);
      expect(res.body.data.notification.id).toBe(aliceNotif1Id);
      expect(res.body.data.notification.title).toBe('Booking 1');
    });

    it('4. prevents Alice from retrieving Bob notification (404 NOT_FOUND / IDOR)', async () => {
      const res = await request(app)
        .get(`/api/v1/customers/me/notifications/${bobNotifId}`)
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('NOTIFICATION_NOT_FOUND');
    });

    it('5. marks a single notification as read (idempotent)', async () => {
      const res1 = await request(app)
        .patch(`/api/v1/customers/me/notifications/${aliceNotif2Id}/read`)
        .set('Authorization', 'Bearer token-alice');

      expect(res1.status).toBe(200);
      expect(res1.body.data.notification.isRead).toBe(true);
      expect(res1.body.data.notification.readAt).toBeDefined();

      // Second call is idempotent
      const res2 = await request(app)
        .patch(`/api/v1/customers/me/notifications/${aliceNotif2Id}/read`)
        .set('Authorization', 'Bearer token-alice');

      expect(res2.status).toBe(200);
      expect(res2.body.data.notification.isRead).toBe(true);
    });

    it('6. marks all unread notifications as read for authenticated customer only', async () => {
      const res = await request(app)
        .patch('/api/v1/customers/me/notifications/read-all')
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(200);
      expect(res.body.data.count).toBe(2);

      // Verify Alice has 0 unread
      const aliceCount = await request(app)
        .get('/api/v1/customers/me/notifications/unread-count')
        .set('Authorization', 'Bearer token-alice');
      expect(aliceCount.body.data.count).toBe(0);

      // Bob's notification is untouched
      const bobCount = await request(app)
        .get('/api/v1/customers/me/notifications/unread-count')
        .set('Authorization', 'Bearer token-bob');
      expect(bobCount.body.data.count).toBe(1);
    });
  });

  describe('Business Event Driven Notifications', () => {
    beforeEach(async () => {
      // Register device for Alice
      await request(app)
        .post('/api/v1/customers/me/devices')
        .set('Authorization', 'Bearer token-alice')
        .send({
          deviceToken: 'fcm_token_alice_active_device_001',
          platform: 'ANDROID',
        });
    });

    it('7. creating booking triggers BOOKING_CREATED notification and dispatches FCM', async () => {
      const { booking } = await bookingService.createBooking(customerAlice.id, {
        vehicleId,
        rentalType: 'DAILY',
        startAt: relDate('2026-11-20T10:00:00Z'),
        endAt: relDate('2026-11-21T10:00:00Z'),
      });

      // Verify notification in DB
      const row = db.public.one(`
        SELECT * FROM notifications
        WHERE customer_id = '${customerAlice.id}' AND type = 'BOOKING_CREATED'
      `);

      expect(row).toBeDefined();
      expect(row.title).toBe('Booking Created');
      expect(row.status).toBe('SENT');

      // Verify FCM mock called
      expect(mockFCM.sendMulticast).toHaveBeenCalledWith(
        expect.objectContaining({
          tokens: ['fcm_token_alice_active_device_001'],
          title: 'Booking Created',
          data: expect.objectContaining({ bookingId: booking.id }),
        }),
      );
    });

    it('8. cancelling booking triggers BOOKING_CANCELLED notification', async () => {
      const { booking } = await bookingService.createBooking(customerAlice.id, {
        vehicleId,
        rentalType: 'DAILY',
        startAt: relDate('2026-11-22T10:00:00Z'),
        endAt: relDate('2026-11-23T10:00:00Z'),
      });

      await bookingService.cancelBooking(customerAlice.id, booking.id, 'Customer changed travel dates');

      const row = db.public.one(`
        SELECT * FROM notifications
        WHERE customer_id = '${customerAlice.id}' AND type = 'BOOKING_CANCELLED'
      `);

      expect(row).toBeDefined();
      expect(row.title).toBe('Booking Cancelled');
    });

    it('9. verified Cashfree SUCCESS webhook triggers PAYMENT_SUCCESS and BOOKING_CONFIRMED', async () => {
      // 1. Create booking
      const { booking } = await bookingService.createBooking(customerAlice.id, {
        vehicleId,
        rentalType: 'DAILY',
        startAt: relDate('2026-11-24T10:00:00Z'),
        endAt: relDate('2026-11-25T10:00:00Z'),
      });

      // 2. Initiate payment
      const orderId = `CF_ORDER_${booking.id.replace(/-/g, '').slice(0, 16)}`;
      db.public.none(`
        INSERT INTO payments (id, booking_id, customer_id, provider, provider_order_id, amount, currency, status)
        VALUES ('99999999-9999-4999-8999-999999999999', '${booking.id}', '${customerAlice.id}', 'CASHFREE', '${orderId}', 2700.00, 'INR', 'CREATED')
      `);

      // 3. Deliver verified SUCCESS webhook
      const webhookPayload = {
        data: {
          order: { order_id: orderId, order_amount: 2700.00, order_currency: 'INR' },
          payment: {
            cf_payment_id: 'cf_pay_notif_test',
            payment_status: 'SUCCESS',
            payment_amount: 2700.00,
            payment_currency: 'INR',
          },
        },
      };
      const rawBody = JSON.stringify(webhookPayload);
      const headers = signPayload(rawBody);

      await paymentService.processWebhook(headers, rawBody, webhookPayload);

      // Verify PAYMENT_SUCCESS notification created
      const payNotif = db.public.one(`
        SELECT * FROM notifications
        WHERE customer_id = '${customerAlice.id}' AND type = 'PAYMENT_SUCCESS'
      `);
      expect(payNotif).toBeDefined();
      expect(payNotif.title).toBe('Payment Successful');

      // Verify BOOKING_CONFIRMED notification created
      const bookNotif = db.public.one(`
        SELECT * FROM notifications
        WHERE customer_id = '${customerAlice.id}' AND type = 'BOOKING_CONFIRMED'
      `);
      expect(bookNotif).toBeDefined();
      expect(bookNotif.title).toBe('Booking Confirmed');
    });

    it('10. duplicate webhook delivery does not generate duplicate notifications (idempotent)', async () => {
      const { booking } = await bookingService.createBooking(customerAlice.id, {
        vehicleId,
        rentalType: 'DAILY',
        startAt: relDate('2026-11-26T10:00:00Z'),
        endAt: relDate('2026-11-27T10:00:00Z'),
      });

      const orderId = `CF_ORDER_${booking.id.replace(/-/g, '').slice(0, 16)}`;
      db.public.none(`
        INSERT INTO payments (id, booking_id, customer_id, provider, provider_order_id, amount, currency, status)
        VALUES ('88888888-8888-4888-8888-888888888888', '${booking.id}', '${customerAlice.id}', 'CASHFREE', '${orderId}', 2700.00, 'INR', 'CREATED')
      `);

      const webhookPayload = {
        data: {
          order: { order_id: orderId, order_amount: 2700.00, order_currency: 'INR' },
          payment: {
            cf_payment_id: 'cf_pay_dup_test',
            payment_status: 'SUCCESS',
            payment_amount: 2700.00,
            payment_currency: 'INR',
          },
        },
      };
      const rawBody = JSON.stringify(webhookPayload);
      const headers = signPayload(rawBody);

      // First webhook
      await paymentService.processWebhook(headers, rawBody, webhookPayload);

      // Second duplicate delivery
      await paymentService.processWebhook(headers, rawBody, webhookPayload);

      const payNotifs = db.public.many(`
        SELECT * FROM notifications
        WHERE customer_id = '${customerAlice.id}' AND type = 'PAYMENT_SUCCESS'
      `);
      expect(payNotifs.length).toBe(1);
    });

    it('11. if FCM delivery fails, notification history is still persisted (decoupled safety)', async () => {
      mockFCM.sendMulticast.mockRejectedValueOnce(new Error('FCM connection dropped'));

      const { booking } = await bookingService.createBooking(customerAlice.id, {
        vehicleId,
        rentalType: 'DAILY',
        startAt: relDate('2026-11-28T10:00:00Z'),
        endAt: relDate('2026-11-29T10:00:00Z'),
      });

      // Booking succeeded despite push failure
      expect(booking.id).toBeDefined();

      // Notification history exists in DB with status FAILED
      const notif = db.public.one(`
        SELECT * FROM notifications
        WHERE customer_id = '${customerAlice.id}' AND type = 'BOOKING_CREATED'
      `);
      expect(notif).toBeDefined();
      expect(notif.status).toBe('FAILED');
    });
  });
});
