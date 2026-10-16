'use strict';

const request = require('supertest');
const { newDb, DataType } = require('pg-mem');
const crypto = require('crypto');

const { pool } = require('../../src/config/database');
const { setMockFirebaseAuth } = require('../../src/config/firebase');
const { createApp } = require('../../src/app');

const usersMigration = require('../../database/migrations/1726300000000_create-users-table');
const deviceTokensMigration = require('../../database/migrations/1727500000000_create-customer-device-tokens-table');

describe('Device Token APIs Integration Tests — Phase 11', () => {
  let app;
  let db;
  let mockPool;

  const customerAlice = {
    id: '11111111-1111-4111-8111-111111111111',
    role: 'customer',
    name: 'Alice Device Customer',
    countryCode: '+91',
    phone: '9870000001',
    email: 'alice.dev@example.com',
    authId: 'auth-alice-dev',
  };

  const customerBob = {
    id: '22222222-2222-4222-8222-222222222222',
    role: 'customer',
    name: 'Bob Device Customer',
    countryCode: '+91',
    phone: '9870000002',
    email: 'bob.dev@example.com',
    authId: 'auth-bob-dev',
  };

  const partnerUser = {
    id: '33333333-3333-4333-8333-333333333333',
    role: 'partner',
    name: 'Partner User',
    countryCode: '+91',
    phone: '9870000003',
    email: 'partner.dev@example.com',
    authId: 'auth-partner-dev',
  };

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
    db.public.none('DELETE FROM customer_device_tokens');
  });

  describe('POST /api/v1/customers/me/devices', () => {
    it('1. authenticated customer can register a new device token (201 Created)', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/devices')
        .set('Authorization', 'Bearer token-alice')
        .send({
          deviceToken: 'fcm_token_alice_device_1_abcdef123456',
          platform: 'ANDROID',
          appVersion: '1.2.0',
          deviceId: 'device-uuid-111',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.device).toBeDefined();
      expect(res.body.data.device.platform).toBe('ANDROID');
      expect(res.body.data.device.appVersion).toBe('1.2.0');
      expect(res.body.data.device.isActive).toBe(true);

      // Verify DB
      const row = db.public.one("SELECT * FROM customer_device_tokens WHERE device_token = 'fcm_token_alice_device_1_abcdef123456'");
      expect(row.customer_id).toBe(customerAlice.id);
    });

    it('2. re-registering an existing token refreshes metadata without creating duplicate row', async () => {
      // First registration
      await request(app)
        .post('/api/v1/customers/me/devices')
        .set('Authorization', 'Bearer token-alice')
        .send({
          deviceToken: 'fcm_shared_token_9999999999',
          platform: 'ANDROID',
          appVersion: '1.0.0',
        });

      // Second registration with updated app version
      const res = await request(app)
        .post('/api/v1/customers/me/devices')
        .set('Authorization', 'Bearer token-alice')
        .send({
          deviceToken: 'fcm_shared_token_9999999999',
          platform: 'ANDROID',
          appVersion: '2.0.0',
        });

      expect([200, 201]).toContain(res.status);
      expect(res.body.data.device.appVersion).toBe('2.0.0');

      const rows = db.public.many("SELECT * FROM customer_device_tokens WHERE device_token = 'fcm_shared_token_9999999999'");
      expect(rows.length).toBe(1);
    });

    it('3. re-registering token by Bob that belonged to Alice safely reassigns ownership to Bob', async () => {
      // Alice registers device
      await request(app)
        .post('/api/v1/customers/me/devices')
        .set('Authorization', 'Bearer token-alice')
        .send({
          deviceToken: 'fcm_device_handoff_token_001',
          platform: 'IOS',
        });

      // Bob logs into same physical device and registers token
      const res = await request(app)
        .post('/api/v1/customers/me/devices')
        .set('Authorization', 'Bearer token-bob')
        .send({
          deviceToken: 'fcm_device_handoff_token_001',
          platform: 'IOS',
        });

      expect([200, 201]).toContain(res.status);

      const row = db.public.one("SELECT * FROM customer_device_tokens WHERE device_token = 'fcm_device_handoff_token_001'");
      expect(row.customer_id).toBe(customerBob.id);
    });

    it('4. rejects unauthenticated request with 401', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/devices')
        .send({
          deviceToken: 'fcm_token_unauth_1234567890',
          platform: 'ANDROID',
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('5. rejects non-customer role (e.g. partner) with 403', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/devices')
        .set('Authorization', 'Bearer token-partner')
        .send({
          deviceToken: 'fcm_token_partner_1234567890',
          platform: 'ANDROID',
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('6. rejects invalid platform with 400 validation error', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/devices')
        .set('Authorization', 'Bearer token-alice')
        .send({
          deviceToken: 'fcm_token_invalid_platform_123',
          platform: 'WEB_BROWSER',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /api/v1/customers/me/devices', () => {
    it('7. lists only the devices belonging to the authenticated customer', async () => {
      // Alice device
      await request(app)
        .post('/api/v1/customers/me/devices')
        .set('Authorization', 'Bearer token-alice')
        .send({
          deviceToken: 'fcm_alice_phone_token_12345',
          platform: 'ANDROID',
        });

      // Bob device
      await request(app)
        .post('/api/v1/customers/me/devices')
        .set('Authorization', 'Bearer token-bob')
        .send({
          deviceToken: 'fcm_bob_phone_token_678901',
          platform: 'IOS',
        });

      const res = await request(app)
        .get('/api/v1/customers/me/devices')
        .set('Authorization', 'Bearer token-alice');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.devices.length).toBe(1);
      expect(res.body.data.devices[0].platform).toBe('ANDROID');
    });
  });

  describe('DELETE /api/v1/customers/me/devices/:deviceId', () => {
    it('8. deactivates device belonging to authenticated customer', async () => {
      const createRes = await request(app)
        .post('/api/v1/customers/me/devices')
        .set('Authorization', 'Bearer token-alice')
        .send({
          deviceToken: 'fcm_alice_to_delete_token_001',
          platform: 'ANDROID',
        });

      const deviceId = createRes.body.data.device.id;

      const delRes = await request(app)
        .delete(`/api/v1/customers/me/devices/${deviceId}`)
        .set('Authorization', 'Bearer token-alice');

      expect(delRes.status).toBe(200);
      expect(delRes.body.success).toBe(true);

      const row = db.public.one(`SELECT * FROM customer_device_tokens WHERE id = '${deviceId}'`);
      expect(row.is_active).toBe(false);
    });

    it('9. prevents Alice from deleting Bob device (404 / IDOR)', async () => {
      const createRes = await request(app)
        .post('/api/v1/customers/me/devices')
        .set('Authorization', 'Bearer token-bob')
        .send({
          deviceToken: 'fcm_bob_private_device_002',
          platform: 'IOS',
        });

      const bobDeviceId = createRes.body.data.device.id;

      const delRes = await request(app)
        .delete(`/api/v1/customers/me/devices/${bobDeviceId}`)
        .set('Authorization', 'Bearer token-alice'); // Alice tries to delete Bob's device

      expect(delRes.status).toBe(404);
      expect(delRes.body.success).toBe(false);
      expect(delRes.body.code).toBe('DEVICE_NOT_FOUND');

      const row = db.public.one(`SELECT * FROM customer_device_tokens WHERE id = '${bobDeviceId}'`);
      expect(row.is_active).toBe(true);
    });
  });
});
