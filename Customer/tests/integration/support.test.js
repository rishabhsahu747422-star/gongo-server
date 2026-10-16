'use strict';

const request = require('supertest');
const { newDb, DataType } = require('pg-mem');
const crypto = require('crypto');

const { pool } = require('../../src/config/database');
const { setMockFirebaseAuth } = require('../../src/config/firebase');
const { createApp } = require('../../src/app');
const firebaseProvider = require('../../src/services/notification/providers/firebase.provider');
const supportService = require('../../src/services/support.service');

const usersMigration = require('../../database/migrations/1726300000000_create-users-table');
const partnersShopsMigration = require('../../database/migrations/1726600000000_create-partners-shops-table');
const categoriesCitiesMigration = require('../../database/migrations/1726700000000_create-categories-cities-table');
const vehiclesMigration = require('../../database/migrations/1726800000000_create-vehicles-table');
const bookingsMigration = require('../../database/migrations/1727000000000_create-bookings-table');
const couponsMigration = require('../../database/migrations/1727200000000_create-coupons-table');
const addCouponColumnsMigration = require('../../database/migrations/1727300000000_add-coupon-columns-to-bookings');
const deviceTokensMigration = require('../../database/migrations/1727500000000_create-customer-device-tokens-table');
const notificationsMigration = require('../../database/migrations/1727600000000_create-notifications-table');
const supportTicketsMigration = require('../../database/migrations/1727700000000_create-support-tickets-table');
const supportMessagesMigration = require('../../database/migrations/1727800000000_create-support-ticket-messages-table');
const addSupportReplyTypeMigration = require('../../database/migrations/1727900000000_add-support-reply-notification-type');

describe('Support System Integration Tests — Phase 12', () => {
  let app;
  let db;
  let mockPool;

  const customerAlice = {
    id: '11111111-1111-4111-8111-111111111111',
    role: 'customer',
    name: 'Alice Support',
    countryCode: '+91',
    phone: '9870000001',
    email: 'alice.support@example.com',
    authId: 'auth-alice-support',
  };

  const customerBob = {
    id: '22222222-2222-4222-8222-222222222222',
    role: 'customer',
    name: 'Bob Support',
    countryCode: '+91',
    phone: '9870000002',
    email: 'bob.support@example.com',
    authId: 'auth-bob-support',
  };

  const partnerUser = {
    id: '33333333-3333-4333-8333-333333333333',
    role: 'partner',
    name: 'Partner Support',
    countryCode: '+91',
    phone: '9870000003',
    email: 'partner.support@example.com',
    authId: 'auth-partner-support',
  };

  const partnerId = '44444444-4444-4444-8444-444444444444';
  const shopId = '55555555-5555-4555-8555-555555555555';
  let categoryId;
  const vehicleId = '66666666-6666-4666-8666-666666666666';
  const aliceBookingId = '77777777-7777-4777-8777-777777777777';
  const bobBookingId = '88888888-8888-4888-8888-888888888888';

  let mockFCM;

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
    await bookingsMigration.up(pgm);
    await couponsMigration.up(pgm);
    await addCouponColumnsMigration.up(pgm);
    await deviceTokensMigration.up(pgm);
    await notificationsMigration.up(pgm);
    await supportTicketsMigration.up(pgm);
    await supportMessagesMigration.up(pgm);
    await addSupportReplyTypeMigration.up(pgm);
    // Mirrors database/migrations/1728500000000_add-global-public-reference-ids.js
    // (that migration also touches tables absent from this fixture, so only the bookings column is applied).
    db.public.none('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_reference VARCHAR(20);');
    // booking_number exists on the shared production bookings table (Partner/database/migrations/
    // 014_create_bookings_table.js, VARCHAR(50)); kept nullable here because fixture seeds omit it.
    db.public.none('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_number VARCHAR(50);');

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
      VALUES ('${partnerId}', '${partnerUser.id}', 'Support Hub Partner', 'approved', true);

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
        60.00, 500.00, 3000.00, 10000.00, 1000.00, 100.00, 8.00, 'ACTIVE', 'Indiranagar Main'
      );
    `);

    // Seed bookings for Alice and Bob
    db.public.none(`
      INSERT INTO bookings (
        id, customer_id, vehicle_id, status, rental_type, start_at, end_at,
        base_amount, discount_amount, security_deposit, total_amount
      ) VALUES
        ('${aliceBookingId}', '${customerAlice.id}', '${vehicleId}', 'ACCEPTED', 'HOURLY',
         NOW() + INTERVAL '1 day', NOW() + INTERVAL '2 days', 500.00, 0, 1000.00, 1500.00),
        ('${bobBookingId}', '${customerBob.id}', '${vehicleId}', 'ACCEPTED', 'HOURLY',
         NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 500.00, 0, 1000.00, 1500.00);
    `);

    const adapter = db.adapters.createPg();
    mockPool = new adapter.Pool();
    pool.query = mockPool.query.bind(mockPool);
    pool.connect = mockPool.connect.bind(mockPool);

    app = createApp();
  });

  beforeEach(() => {
    db.public.none('DELETE FROM support_ticket_messages');
    db.public.none('DELETE FROM support_tickets');
    db.public.none('DELETE FROM notifications');

    mockFCM = {
      sendMulticast: jest.fn().mockResolvedValue({
        successCount: 1,
        failureCount: 0,
        invalidTokens: [],
      }),
    };
    firebaseProvider.setMockDelegate(mockFCM);
  });

  afterAll(async () => {
    if (mockPool) {
      await mockPool.end();
    }
  });

  // ── Ticket Creation ──────────────────────────────────────────────────────────

  describe('POST /api/v1/customers/me/support/tickets', () => {
    it('1. creates support ticket and initial customer message successfully', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/support/tickets')
        .set('Authorization', 'Bearer token-alice')
        .send({
          category: 'BOOKING',
          subject: 'Issue with booking dates',
          message: 'I would like to reschedule my start time by 2 hours.',
          priority: 'HIGH',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.ticket).toBeDefined();

      const { ticket } = res.body.data;
      expect(ticket.customerId).toBe(customerAlice.id);
      expect(ticket.category).toBe('BOOKING');
      expect(ticket.subject).toBe('Issue with booking dates');
      expect(ticket.priority).toBe('HIGH');
      expect(ticket.status).toBe('OPEN');
      expect(ticket.ticketNumber).toMatch(/^TKT-\d{8}-[A-F0-9]{6}$/);
      expect(ticket.messages).toHaveLength(1);
      expect(ticket.messages[0].senderType).toBe('CUSTOMER');
      expect(ticket.messages[0].message).toBe('I would like to reschedule my start time by 2 hours.');
    });

    it('2. creates ticket linked to customer owned booking', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/support/tickets')
        .set('Authorization', 'Bearer token-alice')
        .send({
          category: 'BOOKING',
          subject: 'Deposit inquiry',
          message: 'When will my deposit be released?',
          bookingId: aliceBookingId,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.ticket.bookingId).toBe(aliceBookingId);
    });

    it('3. rejects linking to a booking owned by another customer (403 BOOKING_NOT_OWNED)', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/support/tickets')
        .set('Authorization', 'Bearer token-alice')
        .send({
          category: 'BOOKING',
          subject: 'Not my booking',
          message: 'Trying to access Bob booking',
          bookingId: bobBookingId,
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('BOOKING_NOT_OWNED');
    });

    it('4. rejects linking to a non-existent booking (404 BOOKING_NOT_FOUND)', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/support/tickets')
        .set('Authorization', 'Bearer token-alice')
        .send({
          category: 'BOOKING',
          subject: 'Ghost booking',
          message: 'Querying non-existent booking',
          bookingId: '99999999-9999-4999-8999-999999999999',
        });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('BOOKING_NOT_FOUND');
    });

    it('5. rejects invalid category with 400', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/support/tickets')
        .set('Authorization', 'Bearer token-alice')
        .send({
          category: 'INVALID_CATEGORY',
          subject: 'Invalid cat',
          message: 'Message content',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_CATEGORY');
    });

    it('6. rejects empty message with 400', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/support/tickets')
        .set('Authorization', 'Bearer token-alice')
        .send({
          category: 'ACCOUNT',
          subject: 'My account',
          message: '   ',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('EMPTY_MESSAGE');
    });
  });

  // ── Ticket Listing & Retrieval ──────────────────────────────────────────────

  describe('GET /api/v1/customers/me/support/tickets', () => {
    beforeEach(async () => {
      await supportService.createTicket(customerAlice.id, {
        category: 'BOOKING',
        subject: 'Alice Ticket 1',
        message: 'Message 1',
      });
      await supportService.createTicket(customerAlice.id, {
        category: 'PAYMENT',
        subject: 'Alice Ticket 2',
        message: 'Message 2',
      });
      await supportService.createTicket(customerBob.id, {
        category: 'VEHICLE',
        subject: 'Bob Ticket 1',
        message: 'Message Bob',
      });
    });

    it('7. lists only tickets belonging to authenticated customer with pagination', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me/support/tickets')
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(200);
      expect(res.body.data.tickets).toHaveLength(2);
      expect(res.body.data.pagination.total).toBe(2);
    });

    it('8. filters tickets by category', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me/support/tickets?category=PAYMENT')
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(200);
      expect(res.body.data.tickets).toHaveLength(1);
      expect(res.body.data.tickets[0].category).toBe('PAYMENT');
    });
  });

  // ── Single Ticket Detail & Messages ─────────────────────────────────────────

  describe('GET /api/v1/customers/me/support/tickets/:ticketId', () => {
    let aliceTicket;

    beforeEach(async () => {
      aliceTicket = await supportService.createTicket(customerAlice.id, {
        category: 'TECHNICAL',
        subject: 'App issue',
        message: 'Initial technical issue report',
      });
    });

    it('9. retrieves ticket details along with full message thread', async () => {
      const res = await request(app)
        .get(`/api/v1/customers/me/support/tickets/${aliceTicket.id}`)
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(200);
      expect(res.body.data.ticket.id).toBe(aliceTicket.id);
      expect(res.body.data.ticket.messages).toHaveLength(1);
      expect(res.body.data.ticket.messages[0].message).toBe('Initial technical issue report');
    });

    it('10. returns 404 for non-existent ticket', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me/support/tickets/99999999-9999-4999-8999-999999999999')
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('TICKET_NOT_FOUND');
    });
  });

  // ── Conversation Threading & Lifecycle Transitions ─────────────────────────

  describe('POST /api/v1/customers/me/support/tickets/:ticketId/messages', () => {
    let ticket;

    beforeEach(async () => {
      ticket = await supportService.createTicket(customerAlice.id, {
        category: 'BOOKING',
        subject: 'Dropoff location',
        message: 'Where is the dropoff?',
      });
    });

    it('11. customer appends message to active ticket', async () => {
      const res = await request(app)
        .post(`/api/v1/customers/me/support/tickets/${ticket.id}/messages`)
        .set('Authorization', 'Bearer token-alice')
        .send({
          message: 'Also, can I extend by 1 hour?',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.message.senderType).toBe('CUSTOMER');
      expect(res.body.data.message.message).toBe('Also, can I extend by 1 hour?');
    });

    it('12. customer message reopens ticket to IN_PROGRESS if WAITING_FOR_CUSTOMER', async () => {
      // Support staff replies
      await supportService.addSupportReply(ticket.id, {
        supportAgentId: '99999999-9999-4999-8999-999999999999',
        message: 'Dropoff is at Indiranagar Metro pillar 120.',
      });

      const updated = await supportService.getTicketById(customerAlice.id, ticket.id);
      expect(updated.status).toBe('WAITING_FOR_CUSTOMER');

      // Customer replies
      const res = await request(app)
        .post(`/api/v1/customers/me/support/tickets/${ticket.id}/messages`)
        .set('Authorization', 'Bearer token-alice')
        .send({
          message: 'Got it, thank you!',
        });

      expect(res.status).toBe(201);

      const reopened = await supportService.getTicketById(customerAlice.id, ticket.id);
      expect(reopened.status).toBe('IN_PROGRESS');
    });

    it('13. prevents adding message when ticket is CLOSED (400 TICKET_CLOSED)', async () => {
      await supportService.closeTicket(ticket.id);

      const res = await request(app)
        .post(`/api/v1/customers/me/support/tickets/${ticket.id}/messages`)
        .set('Authorization', 'Bearer token-alice')
        .send({
          message: 'Reply to closed ticket',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('TICKET_CLOSED');
    });
  });
});
