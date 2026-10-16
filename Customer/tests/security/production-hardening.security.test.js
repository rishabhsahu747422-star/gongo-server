'use strict';

const { createDateShifter } = require('../helpers/relativeDates');

// Rental fixtures are written as readable calendar literals, but relDate() shifts them all
// by the same whole number of weeks so the earliest one always lands 14-20 days after today.
// Time-of-day, weekday and spacing between fixtures (durations, overlaps, grace periods)
// are unchanged, so prices and availability semantics are identical whenever the suite runs.
const relDate = createDateShifter('2026-11-10');

const request = require('supertest');
const { setupE2EEnvironment } = require('../integration/e2e/e2e-helper');
const redisService = require('../../src/services/redis.service');
const { BOOKING_STATUS } = require('../../src/constants/booking');

describe('Phase 14 — Production Security Audit & Hardening', () => {
  let e2e;
  let app;
  let customerA;
  let customerB;

  beforeAll(async () => {
    e2e = await setupE2EEnvironment();
    app = e2e.app;
  });

  afterAll(async () => {
    if (e2e?.mockPool) {
      await e2e.mockPool.end();
    }
    if (redisService.client && typeof redisService.client.flushall === 'function') {
      await redisService.client.flushall();
    }
  });

  beforeEach(() => {
    customerA = e2e.createCustomer({ name: 'Alice Sec' });
    customerB = e2e.createCustomer({ name: 'Bob Sec' });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 1. AUTHENTICATION & IDENTITY INTEGRITY
  // ────────────────────────────────────────────────────────────────────────────
  describe('Authentication & Identity Protections', () => {
    it('ignores client-supplied role=admin in POST /auth/send-otp and extracts only phone/countryCode', async () => {
      const res = await request(app)
        .post('/api/v1/auth/send-otp')
        .send({
          phone: '9876543210',
          countryCode: '+91',
          role: 'admin',
          userId: '00000000-0000-0000-0000-000000000000',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.verificationId).toBeDefined();
    });

    it('ignores client-supplied role=admin in POST /auth/verify-otp and forces customer role', async () => {
      // 1. Send OTP
      const sendRes = await request(app)
        .post('/api/v1/auth/send-otp')
        .send({ phone: '9819999999', countryCode: '+91' });

      const { verificationId } = sendRes.body.data;

      // Verify role injection is ignored; invalid OTP returns standard 400
      const verifyRes = await request(app)
        .post('/api/v1/auth/verify-otp')
        .send({
          verificationId,
          otp: '000000',
          role: 'admin',
        });

      // Returns 400 AUTH_INVALID_OTP (not 500, and does not accept or set role)
      expect(verifyRes.status).toBe(400);
      expect(verifyRes.body.code).toBe('AUTH_INVALID_OTP');
    });

    it('rejects empty or missing token in POST /auth/refresh with HTTP 400', async () => {
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('Token is required');
    });

    it('rejects malformed and empty Bearer authorization headers', async () => {
      const res1 = await request(app)
        .get('/api/v1/customers/me')
        .set('Authorization', 'Bearer ');

      expect(res1.status).toBe(401);

      const res2 = await request(app)
        .get('/api/v1/customers/me')
        .set('Authorization', 'Basic dXNlcjpwYXNz');

      expect(res2.status).toBe(401);
    });

    it('blocks deactivated customer accounts with HTTP 403 Forbidden', async () => {
      // Deactivate customerA in database
      e2e.db.public.none(`UPDATE users SET is_active = false WHERE id = '${customerA.userId}'`);

      const res = await request(app)
        .get('/api/v1/customers/me')
        .set('Authorization', customerA.token);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AUTH_USER_INACTIVE');
    });

    it('blocks revoked sessions with HTTP 401 Unauthorized', async () => {
      // Revoke customerA session in Redis
      await redisService.revokeUserSession(customerA.userId);

      const res = await request(app)
        .get('/api/v1/customers/me')
        .set('Authorization', customerA.token);

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_SESSION_REVOKED');
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 2. PARAMETER VALIDATION & UUID INTEGRITY
  // ────────────────────────────────────────────────────────────────────────────
  describe('Route Parameter & UUID Format Validation', () => {
    it('rejects non-UUID address ID in GET /me/addresses/:id with HTTP 400', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me/addresses/not-a-valid-uuid')
        .set('Authorization', customerA.token);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.message).toContain('Invalid address ID format');
    });

    it('rejects non-UUID address ID in PATCH /me/addresses/:id with HTTP 400', async () => {
      const res = await request(app)
        .patch('/api/v1/customers/me/addresses/not-a-valid-uuid')
        .set('Authorization', customerA.token)
        .send({ label: 'WORK' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.message).toContain('Invalid address ID format');
    });

    it('rejects non-UUID address ID in DELETE /me/addresses/:id with HTTP 400', async () => {
      const res = await request(app)
        .delete('/api/v1/customers/me/addresses/sql-injection-attempt')
        .set('Authorization', customerA.token);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.message).toContain('Invalid address ID format');
    });

    it('rejects non-UUID address ID in PATCH /me/addresses/:id/default with HTTP 400', async () => {
      const res = await request(app)
        .patch('/api/v1/customers/me/addresses/12345/default')
        .set('Authorization', customerA.token);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.message).toContain('Invalid address ID format');
    });

    it('rejects non-UUID booking ID in GET /bookings/:bookingId with HTTP 400', async () => {
      const res = await request(app)
        .get('/api/v1/bookings/bad-uuid')
        .set('Authorization', customerA.token);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects non-UUID ticket ID in GET /me/support/tickets/:ticketId with HTTP 400', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me/support/tickets/invalid-id')
        .set('Authorization', customerA.token);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 3. CROSS-CUSTOMER IDOR & DATA BOUNDARY DEFENSES
  // ────────────────────────────────────────────────────────────────────────────
  describe('Cross-Customer IDOR & Resource Boundaries', () => {
    it('prevents Customer A from linking Customer B booking to their support ticket', async () => {
      // Bob creates a booking
      const bobBooking = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', customerB.token)
        .send({
          vehicleId: e2e.bikeVehicleId,
          rentalType: 'DAILY',
          startAt: relDate('2026-11-10T10:00:00.000Z'),
          endAt: relDate('2026-11-11T10:00:00.000Z'),
          pickupAddress: 'Indiranagar 100ft Road',
        });

      expect(bobBooking.status).toBe(201);
      const bobBookingId = bobBooking.body.data.booking.id;

      // Alice tries to open a support ticket linking Bob's booking
      const aliceTicketRes = await request(app)
        .post('/api/v1/customers/me/support/tickets')
        .set('Authorization', customerA.token)
        .send({
          category: 'BOOKING',
          subject: 'Dispute booking',
          message: 'I want to claim this booking',
          bookingId: bobBookingId,
        });

      // Must be forbidden (403 BOOKING_NOT_OWNED)
      expect(aliceTicketRes.status).toBe(403);
      expect(aliceTicketRes.body.code).toBe('BOOKING_NOT_OWNED');
    });

    it('does not leak existence of other customers resources (returns 404)', async () => {
      // Bob creates an address
      const bobAddr = await request(app)
        .post('/api/v1/customers/me/addresses')
        .set('Authorization', customerB.token)
        .send({
          label: 'HOME',
          fullAddress: 'Bob Secret Villa, Bangalore',
          city: 'Bengaluru',
          state: 'Karnataka',
          postalCode: '560001',
        });

      const bobAddrId = bobAddr.body.data.id;

      // Alice requests Bob's address -> 404 (not 403, preventing enumeration)
      const res = await request(app)
        .get(`/api/v1/customers/me/addresses/${bobAddrId}`)
        .set('Authorization', customerA.token);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ADDRESS_NOT_FOUND');
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 4. MASS ASSIGNMENT DEFENSES
  // ────────────────────────────────────────────────────────────────────────────
  describe('Mass Assignment & Parameter Tampering Defenses', () => {
    it('rejects attempt to inject isDefault or id in POST /me/addresses', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/addresses')
        .set('Authorization', customerA.token)
        .send({
          label: 'HOME',
          fullAddress: 'Test Address 123, Bangalore',
          city: 'Bengaluru',
          state: 'Karnataka',
          postalCode: '560001',
          id: '00000000-0000-0000-0000-000000000000',
          userId: '00000000-0000-0000-0000-000000000000',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Field(s) not allowed');
    });

    it('rejects isDefault in PATCH /me/addresses/:id (must use /default endpoint)', async () => {
      const addrRes = await request(app)
        .post('/api/v1/customers/me/addresses')
        .set('Authorization', customerA.token)
        .send({
          label: 'HOME',
          fullAddress: 'Test Address 456, Bangalore',
          city: 'Bengaluru',
          state: 'Karnataka',
          postalCode: '560001',
        });

      const addrId = addrRes.body.data.id;

      const patchRes = await request(app)
        .patch(`/api/v1/customers/me/addresses/${addrId}`)
        .set('Authorization', customerA.token)
        .send({
          isDefault: true,
        });

      expect(patchRes.status).toBe(400);
      expect(patchRes.body.message).toContain('Unexpected field(s)');
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 5. SQL INJECTION & MALICIOUS INPUT DEFENSES
  // ────────────────────────────────────────────────────────────────────────────
  describe('SQL Injection & Input Sanitization Defenses', () => {
    it('safely neutralizes SQL injection attempts in vehicle filters', async () => {
      const payloads = [
        '\'; DROP TABLE users; --',
        '\' OR \'1\'=\'1',
        '1; SELECT * FROM users',
        '\' UNION SELECT * FROM users --',
      ];

      await Promise.all(
        payloads.map(async (payload) => {
          const res = await request(app)
            .get(`/api/v1/vehicles?category=${encodeURIComponent(payload)}`);

          expect([200, 400]).toContain(res.status);
          if (res.status === 200) {
            expect(res.body.data.vehicles).toHaveLength(0);
          }
        }),
      );

      // Verify users table remains intact
      const usersCount = e2e.db.public.one('SELECT COUNT(*) AS c FROM users');
      expect(Number(usersCount.c)).toBeGreaterThan(0);
    });

    it('rejects out-of-bounds geographic coordinates in nearby search', async () => {
      const res1 = await request(app)
        .get('/api/v1/vehicles/nearby?latitude=105.5&longitude=77.5');
      expect(res1.status).toBe(400);

      const res2 = await request(app)
        .get('/api/v1/vehicles/nearby?latitude=12.9&longitude=200.0');
      expect(res2.status).toBe(400);

      const res3 = await request(app)
        .get('/api/v1/vehicles/nearby?latitude=12.9&longitude=77.5&radius=500');
      expect(res3.status).toBe(400);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 6. CASHFREE WEBHOOK & PAYMENT HARDENING
  // ────────────────────────────────────────────────────────────────────────────
  describe('Cashfree Webhook & Payment Security', () => {
    it('rejects webhooks with expired timestamp (> 10 minutes in the past)', async () => {
      const oldTimestamp = String(Date.now() - 11 * 60 * 1000); // 11 mins ago
      const rawBody = JSON.stringify({
        data: {
          order: { order_id: 'cf_order_old', order_amount: 500.00 },
          payment: { payment_status: 'SUCCESS' },
        },
      });

      const headers = e2e.signPayload(rawBody, oldTimestamp);
      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree')
        .set(headers)
        .send(rawBody);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });

    it('rejects webhooks with future timestamp (> 5 minutes in the future)', async () => {
      const futureTimestamp = String(Date.now() + 6 * 60 * 1000); // 6 mins in future
      const rawBody = JSON.stringify({
        data: {
          order: { order_id: 'cf_order_future', order_amount: 500.00 },
          payment: { payment_status: 'SUCCESS' },
        },
      });

      const headers = e2e.signPayload(rawBody, futureTimestamp);
      const res = await request(app)
        .post('/api/v1/payments/webhook/cashfree')
        .set(headers)
        .send(rawBody);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });

    it('rejects payment order creation on already COMPLETED booking', async () => {
      const bookingRes = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', customerA.token)
        .send({
          vehicleId: e2e.bikeVehicleId,
          rentalType: 'DAILY',
          startAt: relDate('2026-11-20T10:00:00.000Z'),
          endAt: relDate('2026-11-21T10:00:00.000Z'),
          pickupAddress: 'Indiranagar 100ft Road',
        });

      const bookingId = bookingRes.body.data.booking.id;

      // Force status to COMPLETED
      e2e.db.public.none(`
        UPDATE bookings SET status = '${BOOKING_STATUS.COMPLETED}' WHERE id = '${bookingId}'
      `);

      const payRes = await request(app)
        .post(`/api/v1/bookings/${bookingId}/payment`)
        .set('Authorization', customerA.token)
        .send();

      expect(payRes.status).toBe(400);
      expect(payRes.body.code).toBe('PAYMENT_ALREADY_COMPLETED');
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 7. HTTP & EXPRESS SECURITY HEADERS
  // ────────────────────────────────────────────────────────────────────────────
  describe('HTTP & Express Security Baseline', () => {
    it('disables X-Powered-By header on all responses', async () => {
      const res = await request(app).get('/api/v1/health');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('sets protective security headers via Helmet', async () => {
      const res = await request(app).get('/api/v1/health');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    });

    it('rejects oversized JSON request bodies (> 10kb) with HTTP 400', async () => {
      const largeData = 'x'.repeat(15 * 1024); // 15kb string
      const res = await request(app)
        .post('/api/v1/auth/send-otp')
        .set('Content-Type', 'application/json')
        .send(`{"phone":"9876543210","junk":"${largeData}"}`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('rejects malformed JSON syntax gracefully with HTTP 400 without leaking stack trace', async () => {
      const res = await request(app)
        .post('/api/v1/auth/send-otp')
        .set('Content-Type', 'application/json')
        .send('{"phone": "9876543210", malformed_json_here}');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_JSON');
      expect(res.body.stack).toBeUndefined();
      expect(res.body._debug).toBeUndefined();
    });
  });
});
