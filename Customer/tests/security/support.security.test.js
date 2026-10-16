'use strict';

const request = require('supertest');
const { newDb, DataType } = require('pg-mem');
const crypto = require('crypto');

const { pool } = require('../../src/config/database');
const { setMockFirebaseAuth } = require('../../src/config/firebase');
const { createApp } = require('../../src/app');
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

describe('Support Security & IDOR Tests — Phase 12', () => {
  let app;
  let db;
  let mockPool;

  const customerAlice = {
    id: '10101010-1010-4010-8010-101010101010',
    role: 'customer',
    name: 'Security Alice',
    countryCode: '+91',
    phone: '9870000001',
    email: 'alice.sec@example.com',
    authId: 'auth-sec-alice',
  };

  const customerBob = {
    id: '20202020-2020-4020-8020-202020202020',
    role: 'customer',
    name: 'Security Bob',
    countryCode: '+91',
    phone: '9870000002',
    email: 'bob.sec@example.com',
    authId: 'auth-sec-bob',
  };

  const partnerUser = {
    id: '30303030-3030-4030-8030-303030303030',
    role: 'partner',
    name: 'Security Partner',
    countryCode: '+91',
    phone: '9870000003',
    email: 'partner.sec@example.com',
    authId: 'auth-sec-partner',
  };

  const partnerId = '40404040-4040-4040-8040-404040404040';
  const shopId = '50505050-5050-4050-8050-505050505050';
  const vehicleId = '60606060-6060-4060-8060-606060606060';
  const aliceBookingId = '70707070-7070-4070-8070-707070707070';

  let aliceTicket;

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

    db.public.none(`
      INSERT INTO vehicles (
        id, shop_id, category_id, brand, model, vehicle_name,
        year, fuel_type, transmission, seats, price_per_hour, price_per_day,
        price_per_week, price_per_month, security_deposit, late_fee_per_hour,
        extra_km_charge, listing_status, pickup_address
      ) VALUES (
        '${vehicleId}', '${shopId}', '${cat.id}', 'Honda', 'Activa 6G',
        'Honda Activa 6G', 2024, 'PETROL', 'AUTOMATIC', 2,
        60.00, 500.00, 3000.00, 10000.00, 1000.00, 100.00, 8.00, 'ACTIVE', 'Indiranagar Main'
      );

      INSERT INTO bookings (
        id, customer_id, vehicle_id, status, rental_type, start_at, end_at,
        base_amount, discount_amount, security_deposit, total_amount
      ) VALUES (
        '${aliceBookingId}', '${customerAlice.id}', '${vehicleId}', 'ACCEPTED', 'HOURLY',
        NOW() + INTERVAL '1 day', NOW() + INTERVAL '2 days', 500.00, 0, 1000.00, 1500.00
      );
    `);

    const adapter = db.adapters.createPg();
    mockPool = new adapter.Pool();
    pool.query = mockPool.query.bind(mockPool);
    pool.connect = mockPool.connect.bind(mockPool);

    app = createApp();
  });

  beforeEach(async () => {
    db.public.none('DELETE FROM support_ticket_messages');
    db.public.none('DELETE FROM support_tickets');

    aliceTicket = await supportService.createTicket(customerAlice.id, {
      category: 'BOOKING',
      subject: 'Alice Private Ticket',
      message: 'Private issue with my booking',
    });
  });

  afterAll(async () => {
    if (mockPool) {
      await mockPool.end();
    }
  });

  // ── IDOR Protection ──────────────────────────────────────────────────────────

  describe('IDOR (Insecure Direct Object Reference) Protection', () => {
    it('1. prevents Customer Bob from viewing Alice support ticket (returns 404)', async () => {
      const res = await request(app)
        .get(`/api/v1/customers/me/support/tickets/${aliceTicket.id}`)
        .set('Authorization', 'Bearer token-bob');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('TICKET_NOT_FOUND');
    });

    it('2. prevents Customer Bob from sending a message to Alice ticket (returns 404)', async () => {
      const res = await request(app)
        .post(`/api/v1/customers/me/support/tickets/${aliceTicket.id}/messages`)
        .set('Authorization', 'Bearer token-bob')
        .send({
          message: 'Hacker message attempting injection into foreign ticket thread',
        });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('TICKET_NOT_FOUND');
    });

    it('3. prevents Customer Bob from linking Alice booking to Bob ticket (returns 403)', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/support/tickets')
        .set('Authorization', 'Bearer token-bob')
        .send({
          category: 'BOOKING',
          subject: 'Bob ticket with Alice booking',
          message: 'Attempting to attach Alice booking',
          bookingId: aliceBookingId,
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('BOOKING_NOT_OWNED');
    });
  });

  // ── Authentication & RBAC ───────────────────────────────────────────────────

  describe('Authentication & Role Enforcement', () => {
    it('4. rejects unauthenticated request without token (401)', async () => {
      const res = await request(app).get('/api/v1/customers/me/support/tickets');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('5. rejects invalid token format (401)', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me/support/tickets')
        .set('Authorization', 'Bearer invalid-token-xyz');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('6. rejects non-customer roles like partner (403)', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me/support/tickets')
        .set('Authorization', 'Bearer token-partner');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });
  });

  // ── Mass Assignment Rejection ────────────────────────────────────────────────

  describe('Mass Assignment Defense', () => {
    it('7. rejects attempts to inject forbidden fields in ticket creation', async () => {
      const forbiddenPayloads = [
        { customerId: customerBob.id },
        { id: '99999999-9999-4999-8999-999999999999' },
        { status: 'RESOLVED' },
        { ticketNumber: 'TKT-CUSTOM-HACK' },
        { resolvedAt: new Date().toISOString() },
        { closedAt: new Date().toISOString() },
      ];

      await Promise.all(
        forbiddenPayloads.map(async (forbidden) => {
          const res = await request(app)
            .post('/api/v1/customers/me/support/tickets')
            .set('Authorization', 'Bearer token-alice')
            .send({
              category: 'OTHER',
              subject: 'Normal subject',
              message: 'Normal message',
              ...forbidden,
            });

          expect(res.status).toBe(400);
          expect(res.body.code).toBe('VALIDATION_ERROR');
          expect(res.body.message).toMatch(/Field\(s\) not allowed/);
        }),
      );
    });

    it('8. rejects attempts to inject senderType or senderId in messages', async () => {
      const res = await request(app)
        .post(`/api/v1/customers/me/support/tickets/${aliceTicket.id}/messages`)
        .set('Authorization', 'Bearer token-alice')
        .send({
          message: 'Attempting to spoof sender',
          senderType: 'SUPPORT',
          senderId: '99999999-9999-4999-8999-999999999999',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.message).toMatch(/Field\(s\) not allowed/);
    });
  });

  // ── Input Sanitization & Boundaries ──────────────────────────────────────────

  describe('Input Validation & Safe Parameterization', () => {
    it('9. rejects invalid UUID in ticketId parameter', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me/support/tickets/not-a-valid-uuid')
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('10. safely handles SQL injection payload in ticketId parameter', async () => {
      const res = await request(app)
        .get("/api/v1/customers/me/support/tickets/' OR '1'='1")
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('11. rejects oversized message exceeding 5000 characters', async () => {
      const oversized = 'A'.repeat(5001);
      const res = await request(app)
        .post(`/api/v1/customers/me/support/tickets/${aliceTicket.id}/messages`)
        .set('Authorization', 'Bearer token-alice')
        .send({
          message: oversized,
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.message).toMatch(/cannot exceed 5000 characters/);
    });

    it('12. rejects message with more than 5 attachments', async () => {
      const attachments = Array(6).fill({ url: 'https://example.com/file.jpg' });
      const res = await request(app)
        .post(`/api/v1/customers/me/support/tickets/${aliceTicket.id}/messages`)
        .set('Authorization', 'Bearer token-alice')
        .send({
          message: 'Message with too many files',
          attachments,
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.message).toMatch(/Maximum 5 attachments allowed/);
    });
  });
});
