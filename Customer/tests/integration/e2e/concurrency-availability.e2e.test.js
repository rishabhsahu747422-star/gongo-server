'use strict';

const { createDateShifter } = require('../../helpers/relativeDates');

// Rental fixtures are written as readable calendar literals, but relDate() shifts them all
// by the same whole number of weeks so the earliest one always lands 14-20 days after today.
// Time-of-day, weekday and spacing between fixtures (durations, overlaps, grace periods)
// are unchanged, so prices and availability semantics are identical whenever the suite runs.
const relDate = createDateShifter('2026-12-01');

const request = require('supertest');
const { setupE2EEnvironment } = require('./e2e-helper');
const redisService = require('../../../src/services/redis.service');
const { BOOKING_STATUS } = require('../../../src/constants/booking');

describe('Concurrency & Availability Invariants E2E — Phase 13', () => {
  let e2e;
  let app;

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

  // ────────────────────────────────────────────────────────────────────────────
  // 1. CONCURRENT OVERLAPPING BOOKING ATTEMPTS ON SAME VEHICLE
  // ────────────────────────────────────────────────────────────────────────────
  it('strictly serializes concurrent overlapping booking requests: exactly 1 succeeds, other receives 409', async () => {
    const customerA = e2e.createCustomer({ phone: '9811111111' });
    const customerB = e2e.createCustomer({ phone: '9822222222' });

    const startAt = relDate('2026-12-01T10:00:00.000Z');
    const endAt = relDate('2026-12-03T10:00:00.000Z');

    const reqA = request(app)
      .post('/api/v1/bookings')
      .set('Authorization', customerA.token)
      .send({
        vehicleId: e2e.bikeVehicleId,
        rentalType: 'DAILY',
        startAt,
        endAt,
        pickupAddress: 'Indiranagar 100ft Road',
      });

    const reqB = request(app)
      .post('/api/v1/bookings')
      .set('Authorization', customerB.token)
      .send({
        vehicleId: e2e.bikeVehicleId,
        rentalType: 'DAILY',
        startAt,
        endAt,
        pickupAddress: 'Indiranagar 100ft Road',
      });

    const [resA, resB] = await Promise.all([reqA, reqB]);

    const statuses = [resA.status, resB.status];
    expect(statuses).toContain(201);
    expect(statuses).toContain(409);

    // Verify database state: exactly 1 booking exists for that window
    const rows = e2e.db.public.many(`
      SELECT id, customer_id, status FROM bookings
      WHERE vehicle_id = '${e2e.bikeVehicleId}'
        AND start_at = '${startAt}'
        AND end_at = '${endAt}'
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(BOOKING_STATUS.PENDING);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 2. CANCELLATION IMMEDIATELY RELEASES AVAILABILITY
  // ────────────────────────────────────────────────────────────────────────────
  it('releases availability immediately upon booking cancellation, allowing new bookings', async () => {
    const customerA = e2e.createCustomer({ phone: '9833333333' });
    const customerB = e2e.createCustomer({ phone: '9844444444' });

    const startAt = relDate('2026-12-10T10:00:00.000Z');
    const endAt = relDate('2026-12-12T10:00:00.000Z');

    // 1. Customer A books the vehicle
    const bookingResA = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', customerA.token)
      .send({
        vehicleId: e2e.bikeVehicleId,
        rentalType: 'DAILY',
        startAt,
        endAt,
        pickupAddress: 'Indiranagar 100ft Road',
      });

    expect(bookingResA.status).toBe(201);
    const bookingIdA = bookingResA.body.data.booking.id;

    // 2. Customer B attempts to book the same window -> 409 Conflict
    const conflictRes = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', customerB.token)
      .send({
        vehicleId: e2e.bikeVehicleId,
        rentalType: 'DAILY',
        startAt,
        endAt,
        pickupAddress: 'Indiranagar 100ft Road',
      });

    expect(conflictRes.status).toBe(409);

    // 3. Customer A cancels their booking
    const cancelRes = await request(app)
      .post(`/api/v1/bookings/${bookingIdA}/cancel`)
      .set('Authorization', customerA.token)
      .send({
        reason: 'Change of travel plans',
      });

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.booking.status).toBe(BOOKING_STATUS.CANCELLED);

    // 4. Customer B immediately re-attempts booking -> now succeeds with 201!
    const retryRes = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', customerB.token)
      .send({
        vehicleId: e2e.bikeVehicleId,
        rentalType: 'DAILY',
        startAt,
        endAt,
        pickupAddress: 'Indiranagar 100ft Road',
      });

    expect(retryRes.status).toBe(201);
    expect(retryRes.body.data.booking.customerId).toBe(customerB.userId);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 3. IDEMPOTENT PAYMENT CREATION UNDER CONCURRENCY
  // ────────────────────────────────────────────────────────────────────────────
  it('handles concurrent payment initiation requests idempotently without duplicate orders', async () => {
    const customer = e2e.createCustomer({ phone: '9855555555' });
    const startAt = relDate('2026-12-15T10:00:00.000Z');
    const endAt = relDate('2026-12-16T10:00:00.000Z');

    const bookingRes = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', customer.token)
      .send({
        vehicleId: e2e.carVehicleId,
        rentalType: 'DAILY',
        startAt,
        endAt,
        pickupAddress: 'Indiranagar 100ft Road',
      });

    expect(bookingRes.status).toBe(201);
    const bookingId = bookingRes.body.data.booking.id;

    // Concurrent payment order initiation with the same Idempotency-Key
    const idemKey = 'pay-idem-key-999';
    const [payA, payB] = await Promise.all([
      request(app)
        .post(`/api/v1/bookings/${bookingId}/payment`)
        .set('Authorization', customer.token)
        .set('Idempotency-Key', idemKey)
        .send(),
      request(app)
        .post(`/api/v1/bookings/${bookingId}/payment`)
        .set('Authorization', customer.token)
        .set('Idempotency-Key', idemKey)
        .send(),
    ]);

    // Both should return success (one created 201, one idempotent 200 or 201)
    expect([200, 201]).toContain(payA.status);
    expect([200, 201]).toContain(payB.status);

    // Verify only ONE active payment record was created in database
    const payments = e2e.db.public.many(`
      SELECT * FROM payments WHERE booking_id = '${bookingId}'
    `);
    expect(payments).toHaveLength(1);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 4. GLOBAL COUPON USAGE LIMIT EXHAUSTION UNDER CONCURRENCY
  // ────────────────────────────────────────────────────────────────────────────
  it('strictly enforces global coupon usage limit under concurrent booking attempts', async () => {
    // Coupon 'ONCEONLY' has usage_limit = 1
    const customer1 = e2e.createCustomer({ phone: '9866666661' });
    const customer2 = e2e.createCustomer({ phone: '9866666662' });

    // Different vehicles to avoid vehicle availability conflict
    const startAt = relDate('2026-12-20T10:00:00.000Z');
    const endAt = relDate('2026-12-21T10:00:00.000Z');

    const req1 = request(app)
      .post('/api/v1/bookings')
      .set('Authorization', customer1.token)
      .send({
        vehicleId: e2e.bikeVehicleId,
        rentalType: 'DAILY',
        startAt,
        endAt,
        couponCode: 'ONCEONLY',
        pickupAddress: 'Indiranagar 100ft Road',
      });

    const req2 = request(app)
      .post('/api/v1/bookings')
      .set('Authorization', customer2.token)
      .send({
        vehicleId: e2e.carVehicleId,
        rentalType: 'DAILY',
        startAt,
        endAt,
        couponCode: 'ONCEONLY',
        pickupAddress: 'Indiranagar 100ft Road',
      });

    const [res1, res2] = await Promise.all([req1, req2]);

    const statuses = [res1.status, res2.status];
    expect(statuses).toContain(201);
    expect(statuses).toContain(400); // coupon limit reached

    // Verify redemption count in DB is exactly 1
    const redemptions = e2e.db.public.many(`
      SELECT * FROM coupon_redemptions
      WHERE coupon_id = '10000000-1000-4000-8000-100000000003'
    `);
    expect(redemptions).toHaveLength(1);
  });
});
