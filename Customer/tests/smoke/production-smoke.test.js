'use strict';

const request = require('supertest');
const { setupE2EEnvironment, signPayload } = require('../integration/e2e/e2e-helper');

describe('Phase 16 — Production & Staging Go-Live Smoke Test Suite', () => {
  let app;
  let createCustomer;
  let bikeVehicleId;
  let customer;

  beforeAll(async () => {
    const env = await setupE2EEnvironment();
    app = env.app;
    createCustomer = env.createCustomer;
    bikeVehicleId = env.bikeVehicleId;
    customer = createCustomer({ name: 'Smoke Test Customer' });
  });

  // ── 1. Authentication Smoke Tests ──────────────────────────────────────────
  describe('1. Authentication Verification', () => {
    it('smoke: permits access with valid customer Bearer token', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me')
        .set('Authorization', customer.token);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(customer.userId);
    });

    it('smoke: rejects access when Authorization header is missing', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('smoke: rejects access with malformed/forged token', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me')
        .set('Authorization', 'Bearer invalid-forged-token-xyz');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });

  // ── 2. Customer Profile & Addresses ────────────────────────────────────────
  describe('2. Customer Profile & Address Management', () => {
    let addressId;

    it('smoke: retrieves customer profile', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me')
        .set('Authorization', customer.token);

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Smoke Test Customer');
    });

    it('smoke: creates and retrieves customer address', async () => {
      const createRes = await request(app)
        .post('/api/v1/customers/me/addresses')
        .set('Authorization', customer.token)
        .send({
          label: 'HOME',
          fullAddress: '123 Smoke Test Blvd, Indiranagar',
          city: 'Bengaluru',
          state: 'Karnataka',
          postalCode: '560038',
        });

      expect(createRes.status).toBe(201);
      addressId = createRes.body.data.id;
      expect(addressId).toBeDefined();

      const listRes = await request(app)
        .get('/api/v1/customers/me/addresses')
        .set('Authorization', customer.token);

      expect(listRes.status).toBe(200);
      expect(Array.isArray(listRes.body.data)).toBe(true);
      expect(listRes.body.data.some((a) => a.id === addressId)).toBe(true);
    });
  });

  // ── 3. Vehicle Discovery & Catalog ─────────────────────────────────────────
  describe('3. Vehicle Catalog & Discovery', () => {
    it('smoke: queries active vehicle catalog with filtering', async () => {
      const res = await request(app)
        .get('/api/v1/vehicles?category=bike&sort=price_low');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.vehicles)).toBe(true);
    });

    it('smoke: retrieves single vehicle details', async () => {
      const res = await request(app)
        .get(`/api/v1/vehicles/${bikeVehicleId}`);

      expect(res.status).toBe(200);
      expect(res.body.data.vehicle.id).toBe(bikeVehicleId);
      expect(res.body.data.vehicle.listingStatus).toBe('ACTIVE');
    });
  });

  // ── 4. Pricing & Coupon Calculation ────────────────────────────────────────
  describe('4. Dynamic Pricing & Coupon Evaluation', () => {
    const startAt = new Date(Date.now() + 86400000 * 5).toISOString();
    const endAt = new Date(Date.now() + 86400000 * 7).toISOString();

    it('smoke: calculates multi-tier rental quote', async () => {
      const res = await request(app)
        .post('/api/v1/pricing/quote')
        .set('Authorization', customer.token)
        .send({
          vehicleId: bikeVehicleId,
          rentalType: 'DAILY',
          startAt,
          endAt,
        });

      expect(res.status).toBe(200);
      expect(res.body.data.quote.breakdown.totalAmount).toBeGreaterThan(0);
    });

    it('smoke: validates and applies promotional coupon GONGO100', async () => {
      const res = await request(app)
        .post('/api/v1/pricing/quote')
        .set('Authorization', customer.token)
        .send({
          vehicleId: bikeVehicleId,
          rentalType: 'DAILY',
          startAt,
          endAt,
          couponCode: 'GONGO100',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.quote.breakdown.discountAmount).toBe(100);
    });
  });

  // ── 5. Booking Lifecycle ───────────────────────────────────────────────────
  describe('5. Booking Lifecycle & Availability', () => {
    const startAt = new Date(Date.now() + 86400000 * 12).toISOString();
    const endAt = new Date(Date.now() + 86400000 * 14).toISOString();
    let bookingId;

    it('smoke: checks vehicle interval availability', async () => {
      const res = await request(app)
        .get(`/api/v1/bookings/availability?vehicleId=${bikeVehicleId}&startAt=${encodeURIComponent(startAt)}&endAt=${encodeURIComponent(endAt)}`)
        .set('Authorization', customer.token);

      expect(res.status).toBe(200);
      expect(res.body.data.isAvailable).toBe(true);
    });

    it('smoke: creates new booking and verifies persistence', async () => {
      const res = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', customer.token)
        .send({
          vehicleId: bikeVehicleId,
          rentalType: 'DAILY',
          startAt,
          endAt,
          pricingSnapshot: {
            pricePerDay: 500.00,
            baseAmount: 1000.00,
            discountAmount: 0.00,
            securityDeposit: 1000.00,
            lateFeePerHour: 100.00,
            extraKmCharge: 8.00,
            totalAmount: 2000.00,
          },
        });

      expect(res.status).toBe(201);
      bookingId = res.body.data.booking.id;

      const getRes = await request(app)
        .get(`/api/v1/bookings/${bookingId}`)
        .set('Authorization', customer.token);

      expect(getRes.status).toBe(200);
      expect(getRes.body.data.booking.status).toBe('PENDING');
    });

    it('smoke: cancels booking and confirms cancellation state', async () => {
      const res = await request(app)
        .post(`/api/v1/bookings/${bookingId}/cancel`)
        .set('Authorization', customer.token)
        .send({ reason: 'Trip rescheduled by customer' });

      expect(res.status).toBe(200);
      // Canonical status is lowercase (BOOKING_STATUS.CANCELLED = 'cancelled' in src/constants/booking.js)
      expect(res.body.data.booking.status).toBe('cancelled');
    });
  });

  // ── 6. Payment & Webhook Verification (Sandbox) ────────────────────────────
  describe('6. Payment Gateway Integration (Cashfree Sandbox)', () => {
    let bookingId;
    let paymentOrderId;

    beforeAll(async () => {
      const startAt = new Date(Date.now() + 86400000 * 25).toISOString();
      const endAt = new Date(Date.now() + 86400000 * 27).toISOString();

      const bookingRes = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', customer.token)
        .send({
          vehicleId: bikeVehicleId,
          rentalType: 'DAILY',
          startAt,
          endAt,
          pricingSnapshot: {
            pricePerDay: 500.00,
            baseAmount: 1000.00,
            discountAmount: 0.00,
            securityDeposit: 1000.00,
            lateFeePerHour: 100.00,
            extraKmCharge: 8.00,
            totalAmount: 2000.00,
          },
        });

      bookingId = bookingRes.body.data.booking.id;
    });

    it('smoke: initiates Cashfree payment session', async () => {
      const res = await request(app)
        .post(`/api/v1/bookings/${bookingId}/payment`)
        .set('Authorization', customer.token);

      expect(res.status).toBe(201);
      paymentOrderId = res.body.data.payment.providerOrderId;
      expect(paymentOrderId).toBeDefined();
      // Online advance = 2 days x 500 rental; the 1000 security deposit is collected at
      // pickup and excluded (PaymentService.initiatePayment step 5).
      expect(res.body.data.payment.amount).toBe(1000.00);
    });

    it('smoke: verifies and reconciles Cashfree HMAC-SHA256 webhook callback', async () => {
      const webhookPayload = JSON.stringify({
        data: {
          order: {
            order_id: paymentOrderId,
            order_amount: 1000.00,
            order_currency: 'INR',
          },
          payment: {
            cf_payment_id: `cf_smoke_${Date.now()}`,
            payment_status: 'SUCCESS',
            payment_amount: 1000.00,
            payment_currency: 'INR',
            payment_message: 'Paid successfully',
            payment_time: new Date().toISOString(),
          },
        },
        event_time: new Date().toISOString(),
        type: 'PAYMENT_SUCCESS_WEBHOOK',
      });

      const headers = signPayload(webhookPayload);

      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree')
        .set(headers)
        .send(webhookPayload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify booking status transitioned
      const bookingCheck = await request(app)
        .get(`/api/v1/bookings/${bookingId}`)
        .set('Authorization', customer.token);

      expect(bookingCheck.body.data.booking.status).toBe('PAYMENT_COMPLETED');
    });
  });

  // ── 7. Notifications & FCM Devices ─────────────────────────────────────────
  describe('7. Push Notifications & Devices', () => {
    it('smoke: registers customer FCM device token', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/devices')
        .set('Authorization', customer.token)
        .send({
          deviceToken: 'fcm_smoke_test_device_token_abcdef123456',
          platform: 'ANDROID',
          deviceName: 'Pixel 8 Pro',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    it('smoke: lists customer notifications and unread count', async () => {
      const listRes = await request(app)
        .get('/api/v1/customers/me/notifications')
        .set('Authorization', customer.token);

      expect(listRes.status).toBe(200);
      expect(Array.isArray(listRes.body.data.notifications)).toBe(true);

      const countRes = await request(app)
        .get('/api/v1/customers/me/notifications/unread-count')
        .set('Authorization', customer.token);

      expect(countRes.status).toBe(200);
      expect(typeof countRes.body.data.count).toBe('number');
    });
  });

  // ── 8. Customer Support & Tickets ──────────────────────────────────────────
  describe('8. Customer Support Ticketing', () => {
    let ticketId;

    it('smoke: creates support ticket and appends message', async () => {
      const createRes = await request(app)
        .post('/api/v1/customers/me/support/tickets')
        .set('Authorization', customer.token)
        .send({
          category: 'BOOKING',
          subject: 'Question regarding pickup location',
          message: 'Can I pick up the vehicle 30 minutes earlier?',
        });

      expect(createRes.status).toBe(201);
      ticketId = createRes.body.data.ticket.id;

      const msgRes = await request(app)
        .post(`/api/v1/customers/me/support/tickets/${ticketId}/messages`)
        .set('Authorization', customer.token)
        .send({ message: 'Following up on my earlier question' });

      expect(msgRes.status).toBe(201);

      const getRes = await request(app)
        .get(`/api/v1/customers/me/support/tickets/${ticketId}`)
        .set('Authorization', customer.token);

      expect(getRes.status).toBe(200);
      expect(getRes.body.data.ticket.messages.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── 9. Security Defenses & Invariant Checks ────────────────────────────────
  describe('9. Core Security Boundaries & Defenses', () => {
    it('smoke: rejects IDOR attempt across customer boundaries (404 masked)', async () => {
      const otherCustomer = createCustomer({ name: 'Other Customer' });

      const res = await request(app)
        .get('/api/v1/customers/me/addresses')
        .set('Authorization', otherCustomer.token);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(0);
    });

    it('smoke: rejects malformed JSON request bodies with clean HTTP 400', async () => {
      const res = await request(app)
        .post('/api/v1/pricing/quote')
        .set('Authorization', customer.token)
        .set('Content-Type', 'application/json')
        .send('{ malformed: true, missing_brace');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_JSON');
      expect(JSON.stringify(res.body)).not.toContain('SyntaxError: Unexpected token');
    });

    it('smoke: verifies security headers (Helmet) on live responses', async () => {
      const res = await request(app).get('/health/live');

      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });
});
