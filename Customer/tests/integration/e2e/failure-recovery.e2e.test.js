'use strict';

const request = require('supertest');
const { setupE2EEnvironment } = require('./e2e-helper');
const redisService = require('../../../src/services/redis.service');
const cashfreeProvider = require('../../../src/services/payment/providers/cashfree.provider');
const firebaseProvider = require('../../../src/services/notification/providers/firebase.provider');
const { BOOKING_STATUS } = require('../../../src/constants/booking');
const { PAYMENT_STATUS } = require('../../../src/constants/payment');
const { TICKET_STATUS } = require('../../../src/constants/support');
const { daysFromNowAt } = require('../../helpers/relativeDates');

// Rental windows must be in the future (booking validator rejects past startAt), so derive
// them from "now" instead of fixed calendar dates; offsets keep the original day spacing.
const futureAt = (dayOffset) => daysFromNowAt(20 + dayOffset, 10);

describe('Failure Recovery & Graceful Degradation E2E — Phase 13', () => {
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
  // 1. FCM NOTIFICATION FAILURE DOES NOT ROLL BACK BOOKINGS OR PAYMENTS
  // ────────────────────────────────────────────────────────────────────────────
  it('resiliently completes booking and payment even when FCM push notification network fails', async () => {
    // Break FCM messaging delegate deliberately
    firebaseProvider.setMockDelegate({
      sendMulticast: jest.fn().mockRejectedValue(new Error('FCM network connection timed out')),
    });

    const startAt = futureAt(1);
    const endAt = futureAt(2);

    // 1. Booking creation must succeed despite FCM failure
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

    expect(bookingRes.status).toBe(201);
    const { booking } = bookingRes.body.data;
    expect(booking.status).toBe(BOOKING_STATUS.PENDING);

    // 2. Initiate Payment Order
    const paymentRes = await request(app)
      .post(`/api/v1/bookings/${booking.id}/payment`)
      .set('Authorization', customer.token)
      .send();

    expect(paymentRes.status).toBe(201);
    const { providerOrderId } = paymentRes.body.data.payment;
    // Online advance = 1 day x 500 rental; the 1000 pickup security deposit is excluded
    // (PaymentService.initiatePayment step 5), so the webhook must report 500.
    expect(Number(paymentRes.body.data.payment.amount)).toBe(500.00);

    // 3. Webhook Delivery: FCM dispatch during webhook handler will fail,
    // but payment & booking must succeed!
    const rawBody = JSON.stringify({
      data: {
        order: { order_id: providerOrderId, order_amount: 500.00, order_currency: 'INR' },
        payment: {
          payment_status: 'SUCCESS',
          payment_amount: 500.00,
          payment_currency: 'INR',
          cf_payment_id: 'cf_recov_123',
        },
      },
      type: 'PAYMENT_SUCCESS_WEBHOOK',
    });

    const headers = e2e.signPayload(rawBody);
    const webhookRes = await request(app)
      .post('/api/v1/payments/webhook/cashfree')
      .set(headers)
      .send(rawBody);

    expect(webhookRes.status).toBe(200);

    // Verify booking is PAYMENT_COMPLETED and payment is SUCCESS
    const refreshedBooking = await request(app)
      .get(`/api/v1/bookings/${booking.id}`)
      .set('Authorization', customer.token);

    expect(refreshedBooking.status).toBe(200);
    // Booking API DTO upper-cases the stored 'payment_completed' (BookingRepository.mapBookingDto)
    expect(refreshedBooking.body.data.booking.status).toBe(BOOKING_STATUS.PAYMENT_COMPLETED.toUpperCase());

    const refreshedPayment = await request(app)
      .get(`/api/v1/bookings/${booking.id}/payment`)
      .set('Authorization', customer.token);

    expect(refreshedPayment.status).toBe(200);
    expect(refreshedPayment.body.data.payment.status).toBe(PAYMENT_STATUS.SUCCESS);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 2. CASHFREE PROVIDER ORDER CREATION FAILURE
  // ────────────────────────────────────────────────────────────────────────────
  it('returns clean error and preserves booking when Cashfree provider fails', async () => {
    // Reset FCM mock to healthy
    firebaseProvider.setMockDelegate({
      sendMulticast: jest.fn().mockResolvedValue({
        successCount: 1,
        failureCount: 0,
        invalidTokens: [],
      }),
    });

    // Mock Cashfree provider failure
    cashfreeProvider.setMockDelegate({
      createOrder: jest.fn().mockRejectedValue(new Error('Cashfree Gateway 502 Bad Gateway')),
    });

    const startAt = futureAt(5);
    const endAt = futureAt(6);

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

    expect(bookingRes.status).toBe(201);
    const bookingId = bookingRes.body.data.booking.id;

    // Payment creation fails cleanly
    const payRes = await request(app)
      .post(`/api/v1/bookings/${bookingId}/payment`)
      .set('Authorization', customer.token)
      .send();

    expect([500, 502]).toContain(payRes.status);
    expect(payRes.body.success).toBe(false);

    // Booking must NOT be in a corrupted or PAYMENT_COMPLETED state
    const bookingCheck = await request(app)
      .get(`/api/v1/bookings/${bookingId}`)
      .set('Authorization', customer.token);

    expect(bookingCheck.status).toBe(200);
    expect(bookingCheck.body.data.booking.status).toBe(BOOKING_STATUS.PENDING);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 3. CLOSED SUPPORT TICKET REJECTION
  // ────────────────────────────────────────────────────────────────────────────
  it('rejects follow-up messages on closed support tickets with HTTP 400', async () => {
    // Create a support ticket
    const ticketRes = await request(app)
      .post('/api/v1/customers/me/support/tickets')
      .set('Authorization', customer.token)
      .send({
        category: 'PAYMENT',
        subject: 'Invoice copy',
        message: 'Please send invoice',
      });

    expect(ticketRes.status).toBe(201);
    const ticketId = ticketRes.body.data.ticket.id;

    // Force ticket status to CLOSED in DB
    e2e.db.public.none(`
      UPDATE support_tickets SET status = '${TICKET_STATUS.CLOSED}' WHERE id = '${ticketId}'
    `);

    // Customer attempts to post message to closed ticket
    const replyRes = await request(app)
      .post(`/api/v1/customers/me/support/tickets/${ticketId}/messages`)
      .set('Authorization', customer.token)
      .send({
        message: 'Still need this invoice!',
      });

    expect(replyRes.status).toBe(400);
    expect(replyRes.body.success).toBe(false);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 4. INVALID STATE TRANSITION DEFENSES
  // ────────────────────────────────────────────────────────────────────────────
  it('rejects payment order initiation on cancelled booking', async () => {
    // Re-enable healthy Cashfree mock
    cashfreeProvider.setMockDelegate({
      createOrder: jest.fn().mockImplementation(async ({ orderId, orderAmount }) => ({
        providerOrderId: orderId,
        paymentSessionId: `cf_sess_${orderId}`,
        orderStatus: 'ACTIVE',
        cfOrderId: `cf_order_${orderId}`,
        orderAmount,
      })),
    });

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

    // Cancel booking
    await request(app)
      .post(`/api/v1/bookings/${bookingId}/cancel`)
      .set('Authorization', customer.token)
      .send({ reason: 'Trip called off' });

    // Attempt to pay for cancelled booking -> 400
    const payRes = await request(app)
      .post(`/api/v1/bookings/${bookingId}/payment`)
      .set('Authorization', customer.token)
      .send();

    expect(payRes.status).toBe(400);
    expect(payRes.body.success).toBe(false);
  });
});
