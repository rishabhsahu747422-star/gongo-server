'use strict';

const request = require('supertest');
const { setupE2EEnvironment } = require('./e2e-helper');
const redisService = require('../../../src/services/redis.service');
const { BOOKING_STATUS } = require('../../../src/constants/booking');
const { PAYMENT_STATUS } = require('../../../src/constants/payment');
const { daysFromNowAt } = require('../../helpers/relativeDates');

// Rental windows must be in the future (pricing/booking validators reject past startAt),
// so derive them from "now" rather than fixed calendar dates. Each offset is a distinct
// day at 10:00 UTC, preserving the original non-overlapping spacing between tests.
const futureAt = (dayOffset) => daysFromNowAt(20 + dayOffset, 10);

describe('Booking & Payment E2E Integration — Phase 13', () => {
  let e2e;
  let app;
  let customer;

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
    customer = e2e.createCustomer();
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 1. FINANCIAL CHAIN INTEGRITY: Quote == Snapshot == Order == Webhook
  // ────────────────────────────────────────────────────────────────────────────
  it('guarantees penny-for-penny financial chain integrity across all lifecycle stages', async () => {
    const startAt = futureAt(1);
    const endAt = futureAt(2); // exactly 1 day = 500.00 base

    // 1. Request Quote with Coupon GONGO100 (100.00 fixed discount)
    const quoteRes = await request(app)
      .post('/api/v1/pricing/quote')
      .set('Authorization', customer.token)
      .send({
        vehicleId: e2e.bikeVehicleId,
        rentalType: 'DAILY',
        startAt,
        endAt,
        couponCode: 'GONGO100',
      });

    expect(quoteRes.status).toBe(200);
    const quoteBreakdown = quoteRes.body.data.quote.breakdown;
    expect(quoteBreakdown.baseAmount).toBe(500.00);
    expect(quoteBreakdown.discountAmount).toBe(100.00);
    expect(quoteBreakdown.securityDeposit).toBe(1000.00);
    expect(quoteBreakdown.totalAmount).toBe(1400.00);

    // 2. Create Booking — verifies snapshot in database matches quote breakdown exactly
    const bookingRes = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', customer.token)
      .send({
        vehicleId: e2e.bikeVehicleId,
        rentalType: 'DAILY',
        startAt,
        endAt,
        couponCode: 'GONGO100',
        pickupAddress: 'Indiranagar 100ft Road',
      });

    expect(bookingRes.status).toBe(201);
    const { booking } = bookingRes.body.data;
    expect(booking.pricingSnapshot.baseAmount).toBe(500.00);
    expect(booking.pricingSnapshot.discountAmount).toBe(100.00);
    expect(booking.pricingSnapshot.securityDeposit).toBe(1000.00);
    expect(booking.pricingSnapshot.totalAmount).toBe(1400.00);
    expect(booking.pricingSnapshot.couponCode).toBe('GONGO100');

    // 3. Initiate Payment Order — order amount is the online payable amount
    // (rental 500 - coupon 100 = 400); the 1000 security deposit is collected at pickup and
    // excluded from the online order (PaymentService.initiatePayment step 5; PricingService payableAmount).
    const paymentRes = await request(app)
      .post(`/api/v1/bookings/${booking.id}/payment`)
      .set('Authorization', customer.token)
      .send();

    expect(paymentRes.status).toBe(201);
    const { payment } = paymentRes.body.data;
    expect(Number(payment.amount)).toBe(400.00);
    expect(payment.currency).toBe('INR');
    // This pg-mem fixture uses the legacy payments schema, so PaymentRepository.create takes
    // its legacy-fallback insert, which stores PAYMENT_STATUS.PENDING as uppercase 'PENDING'
    // (same value asserted in tests/integration/payments.test.js).
    expect(payment.status).toBe(PAYMENT_STATUS.PENDING.toUpperCase());

    // 4. Send Webhook matching order amount
    const rawBody = JSON.stringify({
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
          cf_payment_id: 'cf_pay_test_chain_123',
          payment_method: 'UPI',
        },
      },
      event_time: new Date().toISOString(),
      type: 'PAYMENT_SUCCESS_WEBHOOK',
    });

    const headers = e2e.signPayload(rawBody);
    const webhookRes = await request(app)
      .post('/api/v1/payments/webhook/cashfree')
      .set(headers)
      .send(rawBody);

    expect(webhookRes.status).toBe(200);

    // 5. Booking and Payment status verification
    const finalBooking = await request(app)
      .get(`/api/v1/bookings/${booking.id}`)
      .set('Authorization', customer.token);

    expect(finalBooking.status).toBe(200);
    // Booking API DTO upper-cases the stored 'payment_completed' (BookingRepository.mapBookingDto)
    expect(finalBooking.body.data.booking.status).toBe(BOOKING_STATUS.PAYMENT_COMPLETED.toUpperCase());

    const finalPayment = await request(app)
      .get(`/api/v1/bookings/${booking.id}/payment`)
      .set('Authorization', customer.token);

    expect(finalPayment.status).toBe(200);
    expect(finalPayment.body.data.payment.status).toBe(PAYMENT_STATUS.SUCCESS);
    expect(finalPayment.body.data.payment.isPaid).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 2. ANTI-TAMPERING: Client Price Overrides are Ignored or Rejected
  // ────────────────────────────────────────────────────────────────────────────
  it('enforces server-side authority: client-supplied totalAmount/baseAmount are ignored', async () => {
    const startAt = futureAt(5);
    const endAt = futureAt(6);

    // Malicious customer sends body with totalAmount: 1.00
    const maliciousRes = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', customer.token)
      .send({
        vehicleId: e2e.bikeVehicleId,
        rentalType: 'DAILY',
        startAt,
        endAt,
        pickupAddress: 'Indiranagar 100ft Road',
        baseAmount: 1.00,
        totalAmount: 1.00,
        securityDeposit: 0.00,
      });

    expect(maliciousRes.status).toBe(400);
    expect(maliciousRes.body.success).toBe(false);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 3. WEBHOOK SECURITY: Invalid Signature Rejection
  // ────────────────────────────────────────────────────────────────────────────
  it('rejects Cashfree webhooks with forged or invalid HMAC signature', async () => {
    const rawBody = JSON.stringify({
      data: {
        order: { order_id: 'order_non_existent', order_amount: 500.00 },
        payment: { payment_status: 'SUCCESS' },
      },
    });

    const forgedHeaders = {
      'x-webhook-timestamp': String(Date.now()),
      'x-webhook-signature': 'forged_base64_signature_here==',
      'content-type': 'application/json',
    };

    const res = await request(app)
      .post('/api/v1/payments/webhook/cashfree')
      .set(forgedHeaders)
      .send(rawBody);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 4. WEBHOOK IDEMPOTENCY: Replay Attacks Do Not Double-Process
  // ────────────────────────────────────────────────────────────────────────────
  it('is strictly idempotent on webhook replays and returns 200 without side-effects', async () => {
    const startAt = futureAt(10);
    const endAt = futureAt(11);

    const bookingRes = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', customer.token)
      .send({
        vehicleId: e2e.bikeVehicleId,
        rentalType: 'DAILY',
        startAt,
        endAt,
        pickupAddress: 'Indiranagar 100ft Road',
      });

    const bookingId = bookingRes.body.data.booking.id;

    const paymentRes = await request(app)
      .post(`/api/v1/bookings/${bookingId}/payment`)
      .set('Authorization', customer.token)
      .send();

    const { providerOrderId } = paymentRes.body.data.payment;

    const rawBody = JSON.stringify({
      data: {
        order: { order_id: providerOrderId, order_amount: 500.00, order_currency: 'INR' },
        payment: { payment_status: 'SUCCESS', payment_amount: 500.00, payment_currency: 'INR' },
      },
      type: 'PAYMENT_SUCCESS_WEBHOOK',
    });

    const headers = e2e.signPayload(rawBody);

    // First webhook delivery
    const firstDelivery = await request(app)
      .post('/api/v1/payments/webhook/cashfree')
      .set(headers)
      .send(rawBody);

    expect(firstDelivery.status).toBe(200);

    // Second webhook delivery (replay)
    const replayDelivery = await request(app)
      .post('/api/v1/payments/webhook/cashfree')
      .set(headers)
      .send(rawBody);

    expect(replayDelivery.status).toBe(200);
    expect(replayDelivery.body.data.alreadyProcessed).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 5. AMOUNT MISMATCH TAMPERING IN WEBHOOK
  // ────────────────────────────────────────────────────────────────────────────
  it('rejects webhooks with mismatched order amount and marks payment FAILED', async () => {
    const startAt = futureAt(15);
    const endAt = futureAt(16);

    const bookingRes = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', customer.token)
      .send({
        vehicleId: e2e.bikeVehicleId,
        rentalType: 'DAILY',
        startAt,
        endAt,
        pickupAddress: 'Indiranagar 100ft Road',
      });

    const bookingId = bookingRes.body.data.booking.id;

    const paymentRes = await request(app)
      .post(`/api/v1/bookings/${bookingId}/payment`)
      .set('Authorization', customer.token)
      .send();

    const { providerOrderId } = paymentRes.body.data.payment;

    // Expected amount is 500.00 (deposit excluded); webhook reports 10.00
    const rawBody = JSON.stringify({
      data: {
        order: { order_id: providerOrderId, order_amount: 10.00, order_currency: 'INR' },
        payment: { payment_status: 'SUCCESS', payment_amount: 10.00, payment_currency: 'INR' },
      },
      type: 'PAYMENT_SUCCESS_WEBHOOK',
    });

    const headers = e2e.signPayload(rawBody);
    const res = await request(app)
      .post('/api/v1/payments/webhook/cashfree')
      .set(headers)
      .send(rawBody);

    expect(res.status).toBe(400);

    // Verify payment in DB was marked FAILED with AMOUNT_MISMATCH
    const paymentCheck = await request(app)
      .get(`/api/v1/bookings/${bookingId}/payment`)
      .set('Authorization', customer.token);

    expect(paymentCheck.body.data.payment.status).toBe(PAYMENT_STATUS.FAILED);
    expect(paymentCheck.body.data.payment.failureReason).toBe('AMOUNT_MISMATCH');
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 6. FAILED PAYMENT WEBHOOK
  // ────────────────────────────────────────────────────────────────────────────
  it('marks payment as FAILED and transitions booking to CANCELLED on payment failure', async () => {
    const startAt = futureAt(20);
    const endAt = futureAt(21);

    const bookingRes = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', customer.token)
      .send({
        vehicleId: e2e.bikeVehicleId,
        rentalType: 'DAILY',
        startAt,
        endAt,
        pickupAddress: 'Indiranagar 100ft Road',
      });

    const bookingId = bookingRes.body.data.booking.id;

    const paymentRes = await request(app)
      .post(`/api/v1/bookings/${bookingId}/payment`)
      .set('Authorization', customer.token)
      .send();

    const { providerOrderId } = paymentRes.body.data.payment;

    const rawBody = JSON.stringify({
      data: {
        order: { order_id: providerOrderId, order_amount: 1500.00, order_currency: 'INR' },
        payment: {
          payment_status: 'FAILED',
          payment_amount: 1500.00,
          payment_currency: 'INR',
          payment_message: 'User cancelled UPI transaction',
        },
      },
      type: 'PAYMENT_FAILED_WEBHOOK',
    });

    const headers = e2e.signPayload(rawBody);
    const webhookRes = await request(app)
      .post('/api/v1/payments/webhook/cashfree')
      .set(headers)
      .send(rawBody);

    expect(webhookRes.status).toBe(200);

    // Booking must transition to CANCELLED
    const bookingCheck = await request(app)
      .get(`/api/v1/bookings/${bookingId}`)
      .set('Authorization', customer.token);

    expect(bookingCheck.body.data.booking.status).toBe(BOOKING_STATUS.CANCELLED);

    // Payment must be FAILED
    const paymentCheck = await request(app)
      .get(`/api/v1/bookings/${bookingId}/payment`)
      .set('Authorization', customer.token);

    expect(paymentCheck.body.data.payment.status).toBe(PAYMENT_STATUS.FAILED);
    expect(paymentCheck.body.data.payment.isPaid).toBe(false);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 7. COUPON LIFECYCLE & LIMIT ENFORCEMENT
  // ────────────────────────────────────────────────────────────────────────────
  describe('Coupon Lifecycle & Validation', () => {
    it('rejects expired coupons with HTTP 400', async () => {
      const res = await request(app)
        .post('/api/v1/pricing/quote')
        .set('Authorization', customer.token)
        .send({
          vehicleId: e2e.bikeVehicleId,
          rentalType: 'DAILY',
          startAt: futureAt(32),
          endAt: futureAt(33),
          couponCode: 'EXPIRED50',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects inactive coupons with HTTP 400', async () => {
      const res = await request(app)
        .post('/api/v1/pricing/quote')
        .set('Authorization', customer.token)
        .send({
          vehicleId: e2e.bikeVehicleId,
          rentalType: 'DAILY',
          startAt: futureAt(32),
          endAt: futureAt(33),
          couponCode: 'INACTIVE50',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('enforces per-customer coupon usage limit across multiple bookings', async () => {
      // GONGO20 has per_customer_limit = 1
      // 1. First booking with GONGO20 succeeds
      const booking1 = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', customer.token)
        .send({
          vehicleId: e2e.bikeVehicleId,
          rentalType: 'DAILY',
          startAt: futureAt(36),
          endAt: futureAt(37),
          couponCode: 'GONGO20',
          pickupAddress: 'Indiranagar 100ft Road',
        });

      expect(booking1.status).toBe(201);
      expect(booking1.body.data.booking.pricingSnapshot.couponCode).toBe('GONGO20');

      // 2. Second booking by the same customer with GONGO20 must be rejected
      const booking2 = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', customer.token)
        .send({
          vehicleId: e2e.bikeVehicleId,
          rentalType: 'DAILY',
          startAt: futureAt(38),
          endAt: futureAt(39),
          couponCode: 'GONGO20',
          pickupAddress: 'Indiranagar 100ft Road',
        });

      expect(booking2.status).toBe(400);
      expect(booking2.body.success).toBe(false);
    });
  });
});
