'use strict';

const { createDateShifter } = require('../../helpers/relativeDates');

// Rental fixtures are written as readable calendar literals, but relDate() shifts them all
// by the same whole number of weeks so the earliest one always lands 14-20 days after today.
// Time-of-day, weekday and spacing between fixtures (durations, overlaps, grace periods)
// are unchanged, so prices and availability semantics are identical whenever the suite runs.
const relDate = createDateShifter('2026-11-20');

const request = require('supertest');
const { setupE2EEnvironment } = require('./e2e-helper');
const redisService = require('../../../src/services/redis.service');
const { TICKET_STATUS, TICKET_SENDER_TYPE } = require('../../../src/constants/support');

describe('Cross-Module Tenant Isolation & Security E2E — Phase 13', () => {
  let e2e;
  let app;
  let customerA;
  let customerB;
  const partnerToken = 'Bearer token-partner';

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
    customerA = e2e.createCustomer({ name: 'Alice Customer' });
    customerB = e2e.createCustomer({ name: 'Bob Customer' });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 1. ADDRESSES IDOR PROTECTIONS
  // ────────────────────────────────────────────────────────────────────────────
  it('prevents Customer A from accessing, modifying, or deleting Customer B addresses', async () => {
    // Bob creates an address
    const bobAddrRes = await request(app)
      .post('/api/v1/customers/me/addresses')
      .set('Authorization', customerB.token)
      .send({
        label: 'HOME',
        fullAddress: '42 MG Road, Bangalore',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560001',
      });

    expect(bobAddrRes.status).toBe(201);
    const bobAddrId = bobAddrRes.body.data.id;

    // Alice attempts to update Bob's address
    const aliceUpdate = await request(app)
      .put(`/api/v1/customers/me/addresses/${bobAddrId}`)
      .set('Authorization', customerA.token)
      .send({
        label: 'WORK',
        fullAddress: '100 Alice Road, Bangalore',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560001',
      });

    expect(aliceUpdate.status).toBe(404);

    // Alice attempts to set Bob's address as default
    const aliceSetDefault = await request(app)
      .patch(`/api/v1/customers/me/addresses/${bobAddrId}/default`)
      .set('Authorization', customerA.token);

    expect(aliceSetDefault.status).toBe(404);

    // Alice attempts to delete Bob's address
    const aliceDelete = await request(app)
      .delete(`/api/v1/customers/me/addresses/${bobAddrId}`)
      .set('Authorization', customerA.token);

    expect(aliceDelete.status).toBe(404);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 2. BOOKING & PAYMENT IDOR PROTECTIONS
  // ────────────────────────────────────────────────────────────────────────────
  it('prevents Customer A from viewing, cancelling, or initiating payment on Customer B booking', async () => {
    // Bob creates a booking
    const bobBookingRes = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', customerB.token)
      .send({
        vehicleId: e2e.bikeVehicleId,
        rentalType: 'DAILY',
        startAt: relDate('2026-11-20T10:00:00.000Z'),
        endAt: relDate('2026-11-21T10:00:00.000Z'),
        pickupAddress: 'Indiranagar 100ft Road',
      });

    expect(bobBookingRes.status).toBe(201);
    const bobBookingId = bobBookingRes.body.data.booking.id;

    // Alice attempts to view Bob's booking
    const aliceView = await request(app)
      .get(`/api/v1/bookings/${bobBookingId}`)
      .set('Authorization', customerA.token);

    expect(aliceView.status).toBe(404);

    // Alice attempts to cancel Bob's booking
    const aliceCancel = await request(app)
      .post(`/api/v1/bookings/${bobBookingId}/cancel`)
      .set('Authorization', customerA.token)
      .send({ reason: 'Malicious cancellation' });

    expect(aliceCancel.status).toBe(404);

    // Alice attempts to initiate payment for Bob's booking
    const alicePay = await request(app)
      .post(`/api/v1/bookings/${bobBookingId}/payment`)
      .set('Authorization', customerA.token);

    expect(alicePay.status).toBe(404);

    // Alice attempts to view payment status for Bob's booking
    const alicePayStatus = await request(app)
      .get(`/api/v1/bookings/${bobBookingId}/payment`)
      .set('Authorization', customerA.token);

    expect(alicePayStatus.status).toBe(404);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 3. NOTIFICATIONS IDOR PROTECTIONS
  // ────────────────────────────────────────────────────────────────────────────
  it('prevents Customer A from viewing or modifying Customer B notifications', async () => {
    // Seed notification directly for Bob
    const notifId = '99900000-0000-4000-8000-000000000001';
    e2e.db.public.none(`
      INSERT INTO notifications (id, customer_id, type, title, body, status, created_at)
      VALUES ('${notifId}', '${customerB.userId}', 'BOOKING_CONFIRMED', 'Private Notice', 'For Bob only', 'SENT', NOW());
    `);

    // Alice lists her notifications: Bob's notification must not appear
    const aliceList = await request(app)
      .get('/api/v1/customers/me/notifications')
      .set('Authorization', customerA.token);

    expect(aliceList.status).toBe(200);
    const aliceNotifIds = (aliceList.body.data.notifications || []).map((n) => n.id);
    expect(aliceNotifIds).not.toContain(notifId);

    // Alice attempts to mark Bob's notification as read
    const aliceMark = await request(app)
      .patch(`/api/v1/customers/me/notifications/${notifId}/read`)
      .set('Authorization', customerA.token);

    expect(aliceMark.status).toBe(404);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 4. SUPPORT TICKETS IDOR PROTECTIONS
  // ────────────────────────────────────────────────────────────────────────────
  it('prevents Customer A from viewing or replying to Customer B support tickets', async () => {
    // Bob creates a support ticket
    const bobTicketRes = await request(app)
      .post('/api/v1/customers/me/support/tickets')
      .set('Authorization', customerB.token)
      .send({
        category: 'ACCOUNT',
        subject: 'Bob Private Ticket',
        message: 'Need help with my account details',
        priority: 'LOW',
      });

    expect(bobTicketRes.status).toBe(201);
    const bobTicketId = bobTicketRes.body.data.ticket.id;

    // Alice attempts to view Bob's support ticket
    const aliceView = await request(app)
      .get(`/api/v1/customers/me/support/tickets/${bobTicketId}`)
      .set('Authorization', customerA.token);

    expect(aliceView.status).toBe(404);

    // Alice attempts to send a reply message on Bob's ticket
    const aliceReply = await request(app)
      .post(`/api/v1/customers/me/support/tickets/${bobTicketId}/messages`)
      .set('Authorization', customerA.token)
      .send({
        message: 'I am Alice injecting into Bob conversation',
      });

    expect(aliceReply.status).toBe(404);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 5. ROLE-BASED ACCESS CONTROL (RBAC)
  // ────────────────────────────────────────────────────────────────────────────
  describe('RBAC & Role Enforcement', () => {
    it('rejects partner tokens on customer-only endpoints with HTTP 403', async () => {
      // Profile endpoint
      const meRes = await request(app)
        .get('/api/v1/customers/me')
        .set('Authorization', partnerToken);

      expect(meRes.status).toBe(403);
      expect(meRes.body.success).toBe(false);

      // Booking endpoint
      const bookingRes = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', partnerToken)
        .send({
          vehicleId: e2e.bikeVehicleId,
          rentalType: 'DAILY',
          startAt: relDate('2026-11-25T10:00:00.000Z'),
          endAt: relDate('2026-11-26T10:00:00.000Z'),
        });

      expect(bookingRes.status).toBe(403);
      expect(bookingRes.body.success).toBe(false);

      // Support ticket endpoint
      const ticketRes = await request(app)
        .get('/api/v1/customers/me/support/tickets')
        .set('Authorization', partnerToken);

      expect(ticketRes.status).toBe(403);
      expect(ticketRes.body.success).toBe(false);
    });

    it('rejects unauthenticated requests with HTTP 401', async () => {
      const res = await request(app).get('/api/v1/customers/me');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 6. MASS ASSIGNMENT PROTECTIONS
  // ────────────────────────────────────────────────────────────────────────────
  describe('Mass Assignment & Parameter Injection Protections', () => {
    it('ignores or rejects privilege escalation fields in profile update', async () => {
      const updateRes = await request(app)
        .patch('/api/v1/customers/me')
        .set('Authorization', customerA.token)
        .send({
          name: 'Alice Updated',
          role: 'admin',
          is_active: false,
          is_verified: true,
          auth_provider: 'backdoor',
        });

      // Either returns 400 (strict validation) or successfully updates name
      // while ignoring forbidden fields
      if (updateRes.status === 200) {
        const userRow = e2e.db.public.one(`SELECT * FROM users WHERE id = '${customerA.userId}'`);
        expect(userRow.role).toBe('customer');
        expect(userRow.is_active).toBe(true);
        expect(userRow.name).toBe('Alice Updated');
      } else {
        expect(updateRes.status).toBe(400);
      }
    });

    it('enforces customer senderType and initial OPEN status on ticket creation', async () => {
      const spoofTicketRes = await request(app)
        .post('/api/v1/customers/me/support/tickets')
        .set('Authorization', customerA.token)
        .send({
          category: 'GENERAL',
          subject: 'Spoof Test',
          message: 'Trying to impersonate support',
          status: TICKET_STATUS.RESOLVED,
          senderType: TICKET_SENDER_TYPE.SUPPORT,
        });

      // Whether validation rejects extra fields or sanitizes them:
      if (spoofTicketRes.status === 201) {
        const { ticket } = spoofTicketRes.body.data;
        expect(ticket.status).toBe(TICKET_STATUS.OPEN);
        expect(ticket.messages[0].senderType).toBe(TICKET_SENDER_TYPE.CUSTOMER);
      } else {
        expect(spoofTicketRes.status).toBe(400);
      }
    });
  });
});
