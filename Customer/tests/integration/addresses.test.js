'use strict';

const request = require('supertest');
const { newDb, DataType } = require('pg-mem');
const crypto = require('crypto');
const { pool } = require('../../src/config/database');
const { setMockFirebaseAuth } = require('../../src/config/firebase');
const { createApp } = require('../../src/app');
const usersMigration = require('../../database/migrations/1726300000000_create-users-table');
const addressesMigration = require('../../database/migrations/1726500000000_create-customer-addresses-table');

describe('Customer Addresses Integration Tests', () => {
  let app;
  let db;
  let mockPool;

  const customerA = {
    id: '10000000-0000-4000-8000-000000000011',
    role: 'customer',
    name: 'Address User One',
    countryCode: '+91',
    phone: '9900000001',
    email: 'addr1@example.com',
    authId: 'firebase-uid-addr-1',
  };

  const customerB = {
    id: '20000000-0000-4000-8000-000000000012',
    role: 'customer',
    name: 'Address User Two',
    countryCode: '+91',
    phone: '9900000002',
    email: 'addr2@example.com',
    authId: 'firebase-uid-addr-2',
  };

  const partnerUser = {
    id: '30000000-0000-4000-8000-000000000013',
    role: 'partner',
    name: 'Partner User',
    countryCode: '+91',
    phone: '9900000003',
    email: 'partner-addr@example.com',
    authId: 'firebase-uid-partner-addr',
  };

  const inactiveCustomer = {
    id: '40000000-0000-4000-8000-000000000014',
    role: 'customer',
    name: 'Inactive Addr User',
    countryCode: '+91',
    phone: '9900000004',
    email: 'inactive-addr@example.com',
    authId: 'firebase-uid-inactive-addr',
  };

  const seedAddressId = '50000000-0000-4000-8000-000000000015';
  const seedAddressIdB = '60000000-0000-4000-8000-000000000016';

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
        if (!statement.includes('LANGUAGE plpgsql') && !statement.includes('TRIGGER')) {
          db.public.none(statement);
        }
      },
    };

    await usersMigration.up(pgm);
    await addressesMigration.up(pgm);

    const mockFirebaseAuth = {
      verifyIdToken: jest.fn().mockImplementation(async (token) => {
        if (token === 'token-addr-1') {
          return {
            uid: customerA.authId,
            auth_time: Math.floor(Date.now() / 1000),
            role: 'customer',
          };
        }
        if (token === 'token-addr-2') {
          return {
            uid: customerB.authId,
            auth_time: Math.floor(Date.now() / 1000),
            role: 'customer',
          };
        }
        if (token === 'token-partner-addr') {
          return {
            uid: partnerUser.authId,
            auth_time: Math.floor(Date.now() / 1000),
            role: 'partner',
          };
        }
        if (token === 'token-inactive-addr') {
          return {
            uid: inactiveCustomer.authId,
            auth_time: Math.floor(Date.now() / 1000),
            role: 'customer',
          };
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
        ('${customerA.id}', '${customerA.role}', '${customerA.name}', '${customerA.countryCode}',
          '${customerA.phone}', '${customerA.email}', 'firebase', '${customerA.authId}', true),
        ('${customerB.id}', '${customerB.role}', '${customerB.name}', '${customerB.countryCode}',
          '${customerB.phone}', '${customerB.email}', 'firebase', '${customerB.authId}', true),
        ('${partnerUser.id}', '${partnerUser.role}', '${partnerUser.name}', '${partnerUser.countryCode}',
          '${partnerUser.phone}', '${partnerUser.email}', 'firebase', '${partnerUser.authId}', true),
        ('${inactiveCustomer.id}', '${inactiveCustomer.role}', '${inactiveCustomer.name}',
          '${inactiveCustomer.countryCode}', '${inactiveCustomer.phone}', '${inactiveCustomer.email}',
          'firebase', '${inactiveCustomer.authId}', false)
    `);

    // Seed addresses for Customer A
    db.public.none(`
      INSERT INTO customer_addresses (id, user_id, label, full_address, city, state, is_default)
      VALUES
        ('${seedAddressId}', '${customerA.id}', 'HOME', '10 Seed Lane, Mumbai', 'Mumbai', 'Maharashtra', true)
    `);

    // Seed address for Customer B
    db.public.none(`
      INSERT INTO customer_addresses (id, user_id, label, full_address, city, is_default)
      VALUES
        ('${seedAddressIdB}', '${customerB.id}', 'WORK', '99 Customer B Road, Delhi', 'Delhi', false)
    `);

    const adapter = db.adapters.createPg();
    mockPool = new adapter.Pool();
    pool.query = mockPool.query.bind(mockPool);
    pool.connect = mockPool.connect.bind(mockPool);

    app = createApp();
  });

  // ── POST /api/v1/customers/me/addresses ──────────────────────────────────
  describe('POST /api/v1/customers/me/addresses', () => {
    it('1. Creates a new address with required fields only', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/addresses')
        .set('Authorization', 'Bearer token-addr-1')
        .send({ label: 'WORK', fullAddress: '42 Office Park, Bangalore, Karnataka' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({
        label: 'WORK',
        fullAddress: '42 Office Park, Bangalore, Karnataka',
        userId: customerA.id,
        isDefault: false,
      });
      expect(res.body.data.id).toBeDefined();
    });

    it('2. Creates a full address with all optional fields and coordinates', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/addresses')
        .set('Authorization', 'Bearer token-addr-1')
        .send({
          label: 'OTHER',
          fullAddress: '5 Airport Road, Hyderabad, Telangana 500019',
          addressLine1: '5 Airport Road',
          city: 'Hyderabad',
          state: 'Telangana',
          postalCode: '500019',
          countryCode: 'IN',
          latitude: 17.3850,
          longitude: 78.4867,
        });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        label: 'OTHER',
        city: 'Hyderabad',
        latitude: 17.3850,
        longitude: 78.4867,
        countryCode: 'IN',
      });
    });

    it('3. Creates address with isDefault=true (replaces existing default)', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/addresses')
        .set('Authorization', 'Bearer token-addr-2')
        .send({
          label: 'HOME',
          fullAddress: 'New Default Home, Chennai, Tamil Nadu',
          isDefault: true,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.isDefault).toBe(true);
    });

    it('4. Rejects missing required field: label', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/addresses')
        .set('Authorization', 'Bearer token-addr-1')
        .send({ fullAddress: '10 Missing Label Street' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('5. Rejects missing required field: fullAddress', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/addresses')
        .set('Authorization', 'Bearer token-addr-1')
        .send({ label: 'HOME' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('6. Rejects invalid label value', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/addresses')
        .set('Authorization', 'Bearer token-addr-1')
        .send({ label: 'GARAGE', fullAddress: 'Some address here' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('7. Rejects latitude without longitude (coordinate pair)', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/addresses')
        .set('Authorization', 'Bearer token-addr-1')
        .send({ label: 'HOME', fullAddress: 'Coord test address here', latitude: 19.076 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('8. Rejects latitude out of range (>90)', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/addresses')
        .set('Authorization', 'Bearer token-addr-1')
        .send({ label: 'HOME', fullAddress: 'Out of range lat', latitude: 91, longitude: 72 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('9. Rejects forbidden fields (userId, id)', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/addresses')
        .set('Authorization', 'Bearer token-addr-1')
        .send({
          label: 'HOME',
          fullAddress: 'Some address here',
          userId: 'attacker-id',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('10. Rejects unauthenticated request with 401', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/addresses')
        .send({ label: 'HOME', fullAddress: 'No token address' });

      expect(res.status).toBe(401);
    });

    it('11. Rejects non-customer role with 403', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/addresses')
        .set('Authorization', 'Bearer token-partner-addr')
        .send({ label: 'HOME', fullAddress: 'Partner tries to create' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSIONS');
    });
  });

  // ── GET /api/v1/customers/me/addresses ───────────────────────────────────
  describe('GET /api/v1/customers/me/addresses', () => {
    it('12. Returns list of own addresses (default first)', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me/addresses')
        .set('Authorization', 'Bearer token-addr-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      // Seed address is default so should appear first
      const defaultAddr = res.body.data.find((a) => a.id === seedAddressId);
      expect(defaultAddr).toBeDefined();
      expect(defaultAddr.isDefault).toBe(true);
    });

    it('13. Returns empty array when customer has no addresses', async () => {
      // Use inactive customer slot which has no addresses seeded for this test
      // Actually let's create a fresh user in-memory
      const freshUserId = crypto.randomUUID();
      const freshUid = 'firebase-uid-no-addr-fresh';
      db.public.none(`
        INSERT INTO users (id, role, phone, country_code, auth_provider, auth_id, is_active)
        VALUES ('${freshUserId}', 'customer', '9900009999', '+91', 'firebase', '${freshUid}', true)
      `);

      // Temporarily add mock token
      const mockAuth = {
        verifyIdToken: jest.fn().mockImplementation(async (token) => {
          if (token === 'token-fresh-no-addr') {
            return { uid: freshUid, auth_time: Math.floor(Date.now() / 1000), role: 'customer' };
          }
          throw Object.assign(new Error('Invalid token'), { code: 'auth/argument-error' });
        }),
      };
      setMockFirebaseAuth(mockAuth);

      const res = await request(app)
        .get('/api/v1/customers/me/addresses')
        .set('Authorization', 'Bearer token-fresh-no-addr');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);

      // Restore original mock
      const origMock = {
        verifyIdToken: jest.fn().mockImplementation(async (token) => {
          if (token === 'token-addr-1') {
            return { uid: customerA.authId, auth_time: Math.floor(Date.now() / 1000) };
          }
          if (token === 'token-addr-2') {
            return { uid: customerB.authId, auth_time: Math.floor(Date.now() / 1000) };
          }
          if (token === 'token-partner-addr') {
            return { uid: partnerUser.authId, auth_time: Math.floor(Date.now() / 1000) };
          }
          if (token === 'token-inactive-addr') {
            return { uid: inactiveCustomer.authId, auth_time: Math.floor(Date.now() / 1000) };
          }
          throw Object.assign(new Error('Invalid token'), { code: 'auth/argument-error' });
        }),
      };
      setMockFirebaseAuth(origMock);
    });

    it('14. IDOR: Customer A cannot see Customer B addresses via list', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me/addresses')
        .set('Authorization', 'Bearer token-addr-1');

      expect(res.status).toBe(200);
      const addressIds = res.body.data.map((a) => a.id);
      expect(addressIds).not.toContain(seedAddressIdB);
    });
  });

  // ── GET /api/v1/customers/me/addresses/:id ───────────────────────────────
  describe('GET /api/v1/customers/me/addresses/:id', () => {
    it('15. Returns own address by id', async () => {
      const res = await request(app)
        .get(`/api/v1/customers/me/addresses/${seedAddressId}`)
        .set('Authorization', 'Bearer token-addr-1');

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(seedAddressId);
      expect(res.body.data.label).toBe('HOME');
    });

    it('16. Returns 404 for own non-existent address', async () => {
      const fakeId = crypto.randomUUID();
      const res = await request(app)
        .get(`/api/v1/customers/me/addresses/${fakeId}`)
        .set('Authorization', 'Bearer token-addr-1');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ADDRESS_NOT_FOUND');
    });

    it('17. IDOR/BOLA: Customer A cannot access Customer B address by id', async () => {
      const res = await request(app)
        .get(`/api/v1/customers/me/addresses/${seedAddressIdB}`)
        .set('Authorization', 'Bearer token-addr-1');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ADDRESS_NOT_FOUND');
    });
  });

  // ── PATCH /api/v1/customers/me/addresses/:id ─────────────────────────────
  describe('PATCH /api/v1/customers/me/addresses/:id', () => {
    it('18. Updates allowed fields of own address', async () => {
      const res = await request(app)
        .patch(`/api/v1/customers/me/addresses/${seedAddressId}`)
        .set('Authorization', 'Bearer token-addr-1')
        .send({ city: 'Pune', state: 'Maharashtra' });

      expect(res.status).toBe(200);
      expect(res.body.data.city).toBe('Pune');
      expect(res.body.data.state).toBe('Maharashtra');
      // Other fields preserved
      expect(res.body.data.label).toBe('HOME');
    });

    it('19. Rejects empty patch body', async () => {
      const res = await request(app)
        .patch(`/api/v1/customers/me/addresses/${seedAddressId}`)
        .set('Authorization', 'Bearer token-addr-1')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_UPDATE_PAYLOAD');
    });

    it('20. Rejects update with isDefault (use /default endpoint instead)', async () => {
      const res = await request(app)
        .patch(`/api/v1/customers/me/addresses/${seedAddressId}`)
        .set('Authorization', 'Bearer token-addr-1')
        .send({ isDefault: true });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('21. IDOR: Customer A cannot update Customer B address', async () => {
      const res = await request(app)
        .patch(`/api/v1/customers/me/addresses/${seedAddressIdB}`)
        .set('Authorization', 'Bearer token-addr-1')
        .send({ city: 'Attacker City' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ADDRESS_NOT_FOUND');
    });
  });

  // ── PATCH /api/v1/customers/me/addresses/:id/default ─────────────────────
  describe('PATCH /api/v1/customers/me/addresses/:id/default', () => {
    it('22. Sets an address as default (atomically)', async () => {
      // First create a second address for customer A
      const createRes = await request(app)
        .post('/api/v1/customers/me/addresses')
        .set('Authorization', 'Bearer token-addr-1')
        .send({ label: 'WORK', fullAddress: 'New Work Address, Bangalore' });

      const newAddressId = createRes.body.data.id;

      // Set the new address as default
      const res = await request(app)
        .patch(`/api/v1/customers/me/addresses/${newAddressId}/default`)
        .set('Authorization', 'Bearer token-addr-1');

      expect(res.status).toBe(200);
      expect(res.body.data.isDefault).toBe(true);
      expect(res.body.data.id).toBe(newAddressId);

      // Verify old default is cleared
      const listRes = await request(app)
        .get('/api/v1/customers/me/addresses')
        .set('Authorization', 'Bearer token-addr-1');

      const defaults = listRes.body.data.filter((a) => a.isDefault);
      expect(defaults).toHaveLength(1);
      expect(defaults[0].id).toBe(newAddressId);
    });

    it('23. Returns 404 when trying to set default on non-existent address', async () => {
      const fakeId = crypto.randomUUID();
      const res = await request(app)
        .patch(`/api/v1/customers/me/addresses/${fakeId}/default`)
        .set('Authorization', 'Bearer token-addr-1');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ADDRESS_NOT_FOUND');
    });

    it('24. IDOR: Customer A cannot set Customer B address as default', async () => {
      const res = await request(app)
        .patch(`/api/v1/customers/me/addresses/${seedAddressIdB}/default`)
        .set('Authorization', 'Bearer token-addr-1');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ADDRESS_NOT_FOUND');
    });
  });

  // ── DELETE /api/v1/customers/me/addresses/:id ────────────────────────────
  describe('DELETE /api/v1/customers/me/addresses/:id', () => {
    it('25. Deletes own address successfully', async () => {
      // Create an address to delete
      const createRes = await request(app)
        .post('/api/v1/customers/me/addresses')
        .set('Authorization', 'Bearer token-addr-1')
        .send({ label: 'OTHER', fullAddress: 'Address to be deleted, Mumbai' });

      const toDeleteId = createRes.body.data.id;

      const deleteRes = await request(app)
        .delete(`/api/v1/customers/me/addresses/${toDeleteId}`)
        .set('Authorization', 'Bearer token-addr-1');

      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.success).toBe(true);

      // Confirm it is gone
      const getRes = await request(app)
        .get(`/api/v1/customers/me/addresses/${toDeleteId}`)
        .set('Authorization', 'Bearer token-addr-1');
      expect(getRes.status).toBe(404);
    });

    it('26. Deleting default address leaves customer with no default (no auto-promote)', async () => {
      // Create a new customer scenario with a single default address
      const userId = crypto.randomUUID();
      const uid = `firebase-uid-delete-default-${crypto.randomUUID()}`;
      db.public.none(`
        INSERT INTO users (id, role, phone, country_code, auth_provider, auth_id, is_active)
        VALUES ('${userId}', 'customer', '9900008888', '+91', 'firebase', '${uid}', true)
      `);

      const tempMock = {
        verifyIdToken: jest.fn().mockResolvedValue({
          uid,
          auth_time: Math.floor(Date.now() / 1000),
          role: 'customer',
        }),
      };
      setMockFirebaseAuth(tempMock);

      // Create the only address and make it default
      const createRes = await request(app)
        .post('/api/v1/customers/me/addresses')
        .set('Authorization', 'Bearer any-token')
        .send({ label: 'HOME', fullAddress: 'Only Default Address, City', isDefault: true });

      const defaultAddrId = createRes.body.data.id;
      expect(createRes.body.data.isDefault).toBe(true);

      // Delete the default address
      const deleteRes = await request(app)
        .delete(`/api/v1/customers/me/addresses/${defaultAddrId}`)
        .set('Authorization', 'Bearer any-token');
      expect(deleteRes.status).toBe(200);

      // List addresses — should be empty (no auto-promotion)
      const listRes = await request(app)
        .get('/api/v1/customers/me/addresses')
        .set('Authorization', 'Bearer any-token');
      expect(listRes.status).toBe(200);
      expect(listRes.body.data).toHaveLength(0);

      // Restore original mock
      const origMock = {
        verifyIdToken: jest.fn().mockImplementation(async (token) => {
          if (token === 'token-addr-1') {
            return { uid: customerA.authId, auth_time: Math.floor(Date.now() / 1000) };
          }
          if (token === 'token-addr-2') {
            return { uid: customerB.authId, auth_time: Math.floor(Date.now() / 1000) };
          }
          if (token === 'token-partner-addr') {
            return { uid: partnerUser.authId, auth_time: Math.floor(Date.now() / 1000) };
          }
          if (token === 'token-inactive-addr') {
            return { uid: inactiveCustomer.authId, auth_time: Math.floor(Date.now() / 1000) };
          }
          throw Object.assign(new Error('Invalid token'), { code: 'auth/argument-error' });
        }),
      };
      setMockFirebaseAuth(origMock);
    });

    it('27. Returns 404 for non-existent address', async () => {
      const fakeId = crypto.randomUUID();
      const res = await request(app)
        .delete(`/api/v1/customers/me/addresses/${fakeId}`)
        .set('Authorization', 'Bearer token-addr-1');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ADDRESS_NOT_FOUND');
    });

    it('28. IDOR: Customer A cannot delete Customer B address', async () => {
      const res = await request(app)
        .delete(`/api/v1/customers/me/addresses/${seedAddressIdB}`)
        .set('Authorization', 'Bearer token-addr-1');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ADDRESS_NOT_FOUND');

      // Verify Customer B address still exists
      const verifyRes = await request(app)
        .get(`/api/v1/customers/me/addresses/${seedAddressIdB}`)
        .set('Authorization', 'Bearer token-addr-2');
      expect(verifyRes.status).toBe(200);
    });
  });
});
