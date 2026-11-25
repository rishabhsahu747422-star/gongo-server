'use strict';

const request = require('supertest');
const { newDb, DataType } = require('pg-mem');
const crypto = require('crypto');

const { pool } = require('../../src/config/database');
const { setMockFirebaseAuth } = require('../../src/config/firebase');
const { createApp } = require('../../src/app');

const usersMigration = require('../../database/migrations/1726300000000_create-users-table');
const deviceTokensMigration = require('../../database/migrations/1727500000000_create-customer-device-tokens-table');
const notificationsMigration = require('../../database/migrations/1727600000000_create-notifications-table');

describe('Notification & Device Security Tests — Phase 11', () => {
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

  let bobDeviceId;
  let bobNotifId;

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
        if (!statement.includes('TRIGGER')) {
          db.public.none(statement);
        }
      },
    };

    await usersMigration.up(pgm);
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

    // Seed Bob's device and notification
    bobDeviceId = '55555555-5555-4555-8555-555555555555';
    bobNotifId = '66666666-6666-4666-8666-666666666666';

    db.public.none(`
      INSERT INTO customer_device_tokens (id, customer_id, device_token, platform)
      VALUES ('${bobDeviceId}', '${customerBob.id}', 'fcm_token_bob_sec_001', 'ANDROID');

      INSERT INTO notifications (id, customer_id, type, title, body, status)
      VALUES ('${bobNotifId}', '${customerBob.id}', 'BOOKING_CREATED', 'Bob Booking', 'Confidential', 'SENT');
    `);
  });

  describe('1. Mass Assignment & Input Validation', () => {
    it('rejects client attempting to inject customerId into device registration', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/devices')
        .set('Authorization', 'Bearer token-alice')
        .send({
          deviceToken: 'fcm_token_valid_length_12345',
          platform: 'ANDROID',
          customerId: customerBob.id, // Mass assignment attempt!
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/not allowed/i);
    });

    it('rejects client attempting to set isActive directly', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/devices')
        .set('Authorization', 'Bearer token-alice')
        .send({
          deviceToken: 'fcm_token_valid_length_12345',
          platform: 'ANDROID',
          isActive: false, // Mass assignment attempt!
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/not allowed/i);
    });

    it('rejects overly short device token (< 10 chars)', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/devices')
        .set('Authorization', 'Bearer token-alice')
        .send({
          deviceToken: 'short',
          platform: 'ANDROID',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects non-string device token', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/devices')
        .set('Authorization', 'Bearer token-alice')
        .send({
          deviceToken: 123456789012,
          platform: 'ANDROID',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('2. Horizontal Privilege Escalation (IDOR / BOLA)', () => {
    it('prevents Alice from querying Bob single notification (404 NOT_FOUND)', async () => {
      const res = await request(app)
        .get(`/api/v1/customers/me/notifications/${bobNotifId}`)
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('NOTIFICATION_NOT_FOUND');
    });

    it('prevents Alice from marking Bob notification as read (404 NOT_FOUND)', async () => {
      const res = await request(app)
        .patch(`/api/v1/customers/me/notifications/${bobNotifId}/read`)
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('NOTIFICATION_NOT_FOUND');

      const row = db.public.one(`SELECT * FROM notifications WHERE id = '${bobNotifId}'`);
      expect(row.read_at).toBeNull();
    });

    it('prevents Alice from deactivating Bob device token (404 NOT_FOUND)', async () => {
      const res = await request(app)
        .delete(`/api/v1/customers/me/devices/${bobDeviceId}`)
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('DEVICE_NOT_FOUND');

      const row = db.public.one(`SELECT * FROM customer_device_tokens WHERE id = '${bobDeviceId}'`);
      expect(row.is_active).toBe(true);
    });
  });

  describe('3. SQL Injection Resilience', () => {
    it('safely rejects SQL injection payload in :notificationId route parameter', async () => {
      const maliciousId = "10101010-1010-4010-8010-101010101010' OR '1'='1";
      const res = await request(app)
        .get(`/api/v1/customers/me/notifications/${encodeURIComponent(maliciousId)}`)
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('safely rejects SQL injection payload in :deviceId route parameter', async () => {
      const maliciousId = "55555555-5555-4555-8555-555555555555'; DROP TABLE users; --";
      const res = await request(app)
        .delete(`/api/v1/customers/me/devices/${encodeURIComponent(maliciousId)}`)
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('VALIDATION_ERROR');

      // Users table remains unharmed
      const userCheck = db.public.one(`SELECT COUNT(*) AS c FROM users WHERE id = '${customerAlice.id}'`);
      expect(Number(userCheck.c)).toBe(1);
    });

    it('safely rejects invalid pagination parameter format', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me/notifications?limit=invalid_limit')
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('4. Credentials & Token Leakage Prevention', () => {
    it('never leaks internal secrets or Firebase credentials in device list response', async () => {
      await request(app)
        .post('/api/v1/customers/me/devices')
        .set('Authorization', 'Bearer token-alice')
        .send({
          deviceToken: 'fcm_token_alice_leak_test_123',
          platform: 'ANDROID',
        });

      const res = await request(app)
        .get('/api/v1/customers/me/devices')
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(200);
      const jsonStr = JSON.stringify(res.body);

      // Verify no credential leaks
      expect(jsonStr).not.toMatch(/private_key/i);
      expect(jsonStr).not.toMatch(/client_email/i);
      expect(jsonStr).not.toMatch(/cashfree_secret/i);
    });
  });
});
