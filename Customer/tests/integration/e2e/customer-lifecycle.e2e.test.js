'use strict';

const request = require('supertest');
const { newDb, DataType } = require('pg-mem');
const crypto = require('crypto');

const { pool } = require('../../../src/config/database');
const { setMockFirebaseAuth } = require('../../../src/config/firebase');
const { createApp } = require('../../../src/app');
const redisService = require('../../../src/services/redis.service');
const otpService = require('../../../src/services/otp.service');
const cashfreeProvider = require('../../../src/services/payment/providers/cashfree.provider');
const firebaseProvider = require('../../../src/services/notification/providers/firebase.provider');
const supportService = require('../../../src/services/support.service');
const { BOOKING_STATUS } = require('../../../src/constants/booking');
const { TICKET_STATUS, TICKET_SENDER_TYPE } = require('../../../src/constants/support');

// All migrations in chronological order
const usersMigration = require('../../../database/migrations/1726300000000_create-users-table');
const customerDocumentsMigration = require('../../../database/migrations/1726400000000_create-customer-documents-table');
const customerAddressesMigration = require('../../../database/migrations/1726500000000_create-customer-addresses-table');
const partnersShopsMigration = require('../../../database/migrations/1726600000000_create-partners-shops-table');
const categoriesCitiesMigration = require('../../../database/migrations/1726700000000_create-categories-cities-table');
const vehiclesMigration = require('../../../database/migrations/1726800000000_create-vehicles-table');
const vehicleImagesMigration = require('../../../database/migrations/1726900000000_create-vehicle-images-table');
const bookingsMigration = require('../../../database/migrations/1727000000000_create-bookings-table');
const idempotencyMigration = require('../../../database/migrations/1727100000000_create-idempotency-keys-table');
const couponsMigration = require('../../../database/migrations/1727200000000_create-coupons-table');
const addCouponColumnsMigration = require('../../../database/migrations/1727300000000_add-coupon-columns-to-bookings');
const paymentsMigration = require('../../../database/migrations/1727400000000_create-payments-table');
const deviceTokensMigration = require('../../../database/migrations/1727500000000_create-customer-device-tokens-table');
const notificationsMigration = require('../../../database/migrations/1727600000000_create-notifications-table');
const supportTicketsMigration = require('../../../database/migrations/1727700000000_create-support-tickets-table');
const supportMessagesMigration = require('../../../database/migrations/1727800000000_create-support-ticket-messages-table');
const addSupportReplyTypeMigration = require('../../../database/migrations/1727900000000_add-support-reply-notification-type');

describe('Customer Lifecycle E2E Integration — Phase 13', () => {
  jest.setTimeout(30000);
  let app;
  let db;
  let mockPool;

  const SECRET_KEY = process.env.CASHFREE_SECRET_KEY || 'test_cf_secret_key';

  const partnerUserId = '33333333-3333-4333-8333-333333333333';
  const partnerId = '44444444-4444-4444-8444-444444444444';
  const shopId = '55555555-5555-4555-8555-555555555555';
  let categoryId;
  const vehicleId = '66666666-6666-4666-8666-666666666666';

  let capturedFCM = [];

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
    await customerDocumentsMigration.up(pgm);
    await customerAddressesMigration.up(pgm);
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
    await supportTicketsMigration.up(pgm);
    await supportMessagesMigration.up(pgm);
    await addSupportReplyTypeMigration.up(pgm);

    // Mock Firebase Auth
    const mockFirebaseAuth = {
      createCustomToken: jest.fn().mockImplementation(async (uid, claims = {}) => (
        `mock-token-${claims.gongoUserId || uid}`
      )),
      verifyIdToken: jest.fn().mockImplementation(async (token) => {
        if (token.startsWith('mock-token-')) {
          const gongoUserId = token.replace('mock-token-', '');
          const row = db.public.one(`SELECT * FROM users WHERE id = '${gongoUserId}'`);
          return {
            uid: row.auth_id,
            gongoUserId: row.id,
            auth_time: Math.floor(Date.now() / 1000),
            role: 'customer',
          };
        }
        if (token === 'token-partner') {
          return {
            uid: 'auth-partner-e2e',
            auth_time: Math.floor(Date.now() / 1000),
            role: 'partner',
          };
        }
        const err = new Error('Invalid token');
        err.code = 'auth/argument-error';
        throw err;
      }),
      revokeRefreshTokens: jest.fn().mockResolvedValue(undefined),
    };
    setMockFirebaseAuth(mockFirebaseAuth);

    // Mock Cashfree Provider
    cashfreeProvider.setMockDelegate({
      createOrder: jest.fn().mockImplementation(async ({ orderId, orderAmount }) => ({
        providerOrderId: orderId,
        paymentSessionId: `cf_sess_${orderId}`,
        orderStatus: 'ACTIVE',
        cfOrderId: `cf_order_${orderId}`,
        orderAmount,
      })),
      getOrderStatus: jest.fn().mockResolvedValue({
        orderStatus: 'ACTIVE',
      }),
    });

    // Seed partner, shop, category, and vehicle
    db.public.none(`
      INSERT INTO users (id, role, name, country_code, phone, email, auth_provider, auth_id, is_active)
      VALUES ('${partnerUserId}', 'partner', 'Fast Wheels Partner', '+91', '9888800001', 'partner@e2e.com', 'firebase', 'auth-partner-e2e', true);

      INSERT INTO partners (id, user_id, business_name, verification_status, is_active)
      VALUES ('${partnerId}', '${partnerUserId}', 'Fast Wheels Rentals', 'approved', true);

      INSERT INTO shops (id, partner_id, shop_name, is_active)
      VALUES ('${shopId}', '${partnerId}', 'Indiranagar Hub', true);
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
        'Honda Activa 6G', 2024, 'PETROL', 'AUTOMATIC', 2,
        60.00, 500.00, 3000.00, 10000.00, 1000.00, 100.00, 8.00, 'ACTIVE', 'Indiranagar 100ft Road'
      );

      -- Seed discount coupon for E2E flow
      INSERT INTO coupons (
        id, code, discount_type, discount_value, min_booking_amount,
        max_discount_amount, usage_limit, per_customer_limit,
        valid_from, valid_until, is_active
      ) VALUES (
        '10000000-1000-4000-8000-100000000001', 'GONGO100', 'FIXED', 100.00, 300.00,
        100.00, 100, 5,
        NOW() - INTERVAL '1 day', NOW() + INTERVAL '30 days', true
      );
    `);

    const adapter = db.adapters.createPg();
    mockPool = new adapter.Pool();
    const rawQuery = mockPool.query.bind(mockPool);
    pool.query = async (text, params = []) => {
      let q = text;
      let p = params;
      if (typeof q === 'string') {
        if (q.includes('primary_image_url')) {
          q = q.replace(
            /\(\s*SELECT\s+'placeholder:'\s*\|\|\s*vi\.id::text[\s\S]*?LIMIT\s*1\s*\)\s*AS\s*primary_image_url/gi,
            'NULL AS primary_image_url',
          );
        }
        if (q.includes('= ANY($1::text[])')) {
          q = q.replace('= ANY($1::text[])', "IN ('verified', 'approved')");
          p = p.slice(1);
          q = q.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n, 10) - 1}`);
        }
      }
      return rawQuery(q, p);
    };
    pool.connect = mockPool.connect.bind(mockPool);

    app = createApp();
  });

  beforeEach(() => {
    capturedFCM = [];
    firebaseProvider.setMockDelegate({
      sendMulticast: jest.fn().mockImplementation(async (payload) => {
        capturedFCM.push(payload);
        return {
          successCount: payload.tokens.length,
          failureCount: 0,
          invalidTokens: [],
        };
      }),
    });
  });

  afterAll(async () => {
    if (mockPool) {
      await mockPool.end();
    }
    if (redisService.client && typeof redisService.client.flushall === 'function') {
      await redisService.client.flushall();
    }
  });

  // ── THE COMPLETE HAPPY PATH END-TO-END SCENARIO ──────────────────────────────

  it('executes full customer journey from authentication to support reply', async () => {
    const customerPhone = '9876543210';
    const countryCode = '+91';

    // ──────────────────────────────────────────────────────────────────────────
    // Step 1: Authentication (Send OTP & Verify OTP)
    // ──────────────────────────────────────────────────────────────────────────
    const otpRes = await request(app)
      .post('/api/v1/auth/send-otp')
      .send({ phone: customerPhone, countryCode });

    expect(otpRes.status).toBe(200);
    expect(otpRes.body.success).toBe(true);
    expect(otpRes.body.data.verificationId).toBeDefined();

    const { verificationId } = otpRes.body.data;

    // Simulate known OTP verification via Redis mock state
    const knownOtp = '654321';
    const hashedOtp = otpService.hashOtp(knownOtp);
    await redisService.setOtpState(verificationId, {
      countryCode,
      phone: customerPhone,
      hashedOtp,
      attempts: 0,
      createdAt: Date.now(),
    }, 300);

    const verifyRes = await request(app)
      .post('/api/v1/auth/verify-otp')
      .send({ verificationId, otp: knownOtp });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.success).toBe(true);
    expect(verifyRes.body.data.user).toBeDefined();
    expect(verifyRes.body.data.user.role).toBe('customer');

    const customerUser = verifyRes.body.data.user;
    const customerAuthToken = `Bearer ${verifyRes.body.data.accessToken}`;

    // ──────────────────────────────────────────────────────────────────────────
    // Step 2: Customer Profile (Get & Update)
    // ──────────────────────────────────────────────────────────────────────────
    const profileRes = await request(app)
      .get('/api/v1/customers/me')
      .set('Authorization', customerAuthToken);

    expect(profileRes.status).toBe(200);
    expect(profileRes.body.data.phone).toBe(customerPhone);

    const updateProfileRes = await request(app)
      .patch('/api/v1/customers/me')
      .set('Authorization', customerAuthToken)
      .send({
        name: 'Rohan Sharma',
        email: 'rohan.sharma@example.com',
      });

    expect(updateProfileRes.status).toBe(200);
    expect(updateProfileRes.body.data.name).toBe('Rohan Sharma');
    expect(updateProfileRes.body.data.email).toBe('rohan.sharma@example.com');

    // ──────────────────────────────────────────────────────────────────────────
    // Step 3: Saved Address Management
    // ──────────────────────────────────────────────────────────────────────────
    const addAddressRes = await request(app)
      .post('/api/v1/customers/me/addresses')
      .set('Authorization', customerAuthToken)
      .send({
        label: 'HOME',
        fullAddress: 'Flat 402, Sunshine Apartments, Bengaluru, Karnataka',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560038',
        isDefault: false,
      });

    expect(addAddressRes.status).toBe(201);
    const addressId = addAddressRes.body.data.id;

    const setDefaultRes = await request(app)
      .patch(`/api/v1/customers/me/addresses/${addressId}/default`)
      .set('Authorization', customerAuthToken);

    expect(setDefaultRes.status).toBe(200);
    expect(setDefaultRes.body.data.isDefault).toBe(true);

    // ──────────────────────────────────────────────────────────────────────────
    // Step 4: Vehicle Discovery
    // ──────────────────────────────────────────────────────────────────────────
    const searchRes = await request(app)
      .get('/api/v1/vehicles?category=bike')
      .set('Authorization', customerAuthToken);

    expect(searchRes.status).toBe(200);
    expect(searchRes.body.data.vehicles.length).toBeGreaterThan(0);

    const vehicleDetailRes = await request(app)
      .get(`/api/v1/vehicles/${vehicleId}`)
      .set('Authorization', customerAuthToken);

    expect(vehicleDetailRes.status).toBe(200);
    expect(vehicleDetailRes.body.data.vehicle.id).toBe(vehicleId);

    // ──────────────────────────────────────────────────────────────────────────
    // Step 5: Pricing Quote with Coupon
    // ──────────────────────────────────────────────────────────────────────────
    const startAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const endAt = new Date(Date.now() + 48 * 3600 * 1000).toISOString(); // 24 hours = 1 day

    const quoteRes = await request(app)
      .post('/api/v1/pricing/quote')
      .set('Authorization', customerAuthToken)
      .send({
        vehicleId,
        rentalType: 'DAILY',
        startAt,
        endAt,
        couponCode: 'GONGO100',
      });

    expect(quoteRes.status).toBe(200);
    expect(quoteRes.body.data.quote.breakdown.baseAmount).toBe(500.00);
    expect(quoteRes.body.data.quote.breakdown.discountAmount).toBe(100.00);
    expect(quoteRes.body.data.quote.breakdown.securityDeposit).toBe(1000.00);
    expect(quoteRes.body.data.quote.breakdown.totalAmount).toBe(1400.00); // 500 - 100 + 1000

    // ──────────────────────────────────────────────────────────────────────────
    // Step 6: Booking Creation
    // ──────────────────────────────────────────────────────────────────────────
    const bookingRes = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', customerAuthToken)
      .set('Idempotency-Key', 'e2e-booking-key-001')
      .send({
        vehicleId,
        rentalType: 'DAILY',
        startAt,
        endAt,
        couponCode: 'GONGO100',
        pickupAddress: 'Indiranagar 100ft Road',
      });

    expect(bookingRes.status).toBe(201);
    const { booking } = bookingRes.body.data;
    expect(booking.customerId).toBe(customerUser.id);
    expect(booking.status).toBe(BOOKING_STATUS.PENDING);
    expect(booking.pricingSnapshot.totalAmount).toBe(1400.00);
    expect(booking.pricingSnapshot.discountAmount).toBe(100.00);

    // Verify BOOKING_CREATED notification was recorded
    const notifsAfterBooking = await request(app)
      .get('/api/v1/customers/me/notifications')
      .set('Authorization', customerAuthToken);

    expect(notifsAfterBooking.status).toBe(200);
    expect(notifsAfterBooking.body.data.notifications.some(
      (n) => n.type === 'BOOKING_CREATED',
    )).toBe(true);

    // ──────────────────────────────────────────────────────────────────────────
    // Step 7: Register Device Token
    // ──────────────────────────────────────────────────────────────────────────
    const deviceRes = await request(app)
      .post('/api/v1/customers/me/devices')
      .set('Authorization', customerAuthToken)
      .send({
        deviceToken: 'fcm_token_e2e_device_999999',
        platform: 'ANDROID',
        appVersion: '1.2.0',
      });

    expect(deviceRes.status).toBe(201);
    expect(deviceRes.body.data.device.platform).toBe('ANDROID');

    // ──────────────────────────────────────────────────────────────────────────
    // Step 8: Payment Order Initiation
    // ──────────────────────────────────────────────────────────────────────────
    const paymentOrderRes = await request(app)
      .post(`/api/v1/bookings/${booking.id}/payment`)
      .set('Authorization', customerAuthToken)
      .send();

    expect(paymentOrderRes.status).toBe(201);
    const { payment } = paymentOrderRes.body.data;
    expect(payment.amount).toBe(400.00); // 500 rental - 100 coupon (security deposit is paid separately at pickup)
    expect(payment.status).toBe('PENDING');
    expect(payment.providerOrderId).toBeDefined();

    // ──────────────────────────────────────────────────────────────────────────
    // Step 9: Cashfree Payment Success Webhook
    // ──────────────────────────────────────────────────────────────────────────
    const webhookPayload = {
      data: {
        order: {
          order_id: payment.providerOrderId,
          order_amount: 400.00,
          order_currency: 'INR',
        },
        payment: {
          payment_status: 'SUCCESS',
          payment_amount: 400.00,
          payment_currency: 'INR',
          cf_payment_id: 'cf_pay_test_999999',
          payment_method: 'UPI',
        },
      },
      event_time: new Date().toISOString(),
      type: 'PAYMENT_SUCCESS_WEBHOOK',
    };

    const rawWebhookBody = JSON.stringify(webhookPayload);
    const webhookHeaders = signPayload(rawWebhookBody);

    const webhookRes = await request(app)
      .post('/api/v1/payments/webhook/cashfree')
      .set(webhookHeaders)
      .send(rawWebhookBody);

    expect(webhookRes.status).toBe(200);
    expect(webhookRes.body.success).toBe(true);

    // Verify booking is now PAYMENT_COMPLETED
    const refreshedBookingRes = await request(app)
      .get(`/api/v1/bookings/${booking.id}`)
      .set('Authorization', customerAuthToken);

    expect(refreshedBookingRes.status).toBe(200);
    expect(refreshedBookingRes.body.data.booking.status.toLowerCase()).toBe(BOOKING_STATUS.PAYMENT_COMPLETED.toLowerCase());

    // ──────────────────────────────────────────────────────────────────────────
    // Step 10: Verify Notifications Delivered with Branded Sound
    // ──────────────────────────────────────────────────────────────────────────
    const notifsAfterPayment = await request(app)
      .get('/api/v1/customers/me/notifications')
      .set('Authorization', customerAuthToken);

    expect(notifsAfterPayment.status).toBe(200);
    const notifTypes = notifsAfterPayment.body.data.notifications.map((n) => n.type);
    expect(notifTypes).toContain('PAYMENT_SUCCESS');
    expect(notifTypes).toContain('BOOKING_CONFIRMED');

    // Verify FCM multicast call happened with branded sound
    expect(capturedFCM.length).toBeGreaterThan(0);
    const lastFCM = capturedFCM[capturedFCM.length - 1];
    expect(lastFCM.sound).toBe('gongo_tune');
    expect(lastFCM.channelId).toBe('gongo_rental_notifications');

    // Mark notification read
    const targetNotif = notifsAfterPayment.body.data.notifications[0];
    const markReadRes = await request(app)
      .patch(`/api/v1/customers/me/notifications/${targetNotif.id}/read`)
      .set('Authorization', customerAuthToken);

    expect(markReadRes.status).toBe(200);
    expect(markReadRes.body.data.notification.isRead).toBe(true);

    // ──────────────────────────────────────────────────────────────────────────
    // Step 11: Support Ticket & Thread Conversation
    // ──────────────────────────────────────────────────────────────────────────
    const ticketRes = await request(app)
      .post('/api/v1/customers/me/support/tickets')
      .set('Authorization', customerAuthToken)
      .send({
        category: 'BOOKING',
        subject: 'Helmet request for my booking',
        message: 'Could you please include a large size helmet with the vehicle?',
        bookingId: booking.id,
        priority: 'MEDIUM',
      });

    expect(ticketRes.status).toBe(201);
    const { ticket } = ticketRes.body.data;
    expect(ticket.bookingId).toBe(booking.id);
    expect(ticket.status).toBe(TICKET_STATUS.OPEN);
    expect(ticket.messages[0].senderType).toBe(TICKET_SENDER_TYPE.CUSTOMER);

    // Support agent replies
    capturedFCM = [];
    const agentReply = await supportService.addSupportReply(ticket.id, {
      supportAgentId: '99999999-9999-4999-8999-999999999999',
      message: 'Yes, a large size helmet has been assigned to your vehicle.',
    });

    expect(agentReply.senderType).toBe(TICKET_SENDER_TYPE.SUPPORT);

    // Verify support reply triggered notification with support channel and custom sound
    expect(capturedFCM.length).toBe(1);
    expect(capturedFCM[0].sound).toBe('gongo_tune');
    expect(capturedFCM[0].channelId).toBe('gongo_support_notifications');

    // Verify ticket status transitioned to WAITING_FOR_CUSTOMER
    const ticketDetailRes = await request(app)
      .get(`/api/v1/customers/me/support/tickets/${ticket.id}`)
      .set('Authorization', customerAuthToken);

    expect(ticketDetailRes.status).toBe(200);
    expect(ticketDetailRes.body.data.ticket.status).toBe(TICKET_STATUS.WAITING_FOR_CUSTOMER);
    expect(ticketDetailRes.body.data.ticket.messages).toHaveLength(2);

    // Customer replies back -> automatically reopens ticket to IN_PROGRESS
    const customerFollowUpRes = await request(app)
      .post(`/api/v1/customers/me/support/tickets/${ticket.id}/messages`)
      .set('Authorization', customerAuthToken)
      .send({
        message: 'Thank you for confirming!',
      });

    expect(customerFollowUpRes.status).toBe(201);

    const recheckTicketRes = await request(app)
      .get(`/api/v1/customers/me/support/tickets/${ticket.id}`)
      .set('Authorization', customerAuthToken);

    expect(recheckTicketRes.status).toBe(200);
    expect(recheckTicketRes.body.data.ticket.status).toBe(TICKET_STATUS.IN_PROGRESS);
    expect(recheckTicketRes.body.data.ticket.messages).toHaveLength(3);
  });
});
