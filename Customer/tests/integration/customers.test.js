'use strict';

const request = require('supertest');
const { newDb, DataType } = require('pg-mem');
const crypto = require('crypto');
const { pool } = require('../../src/config/database');
const { setMockFirebaseAuth } = require('../../src/config/firebase');
const { createApp } = require('../../src/app');
const usersMigration = require('../../database/migrations/1726300000000_create-users-table');
const docMigration = require('../../database/migrations/1726400000000_create-customer-documents-table');

describe('Customer Profile & Documents Integration Tests', () => {
  let app;
  let db;
  let mockPool;
  let mockFirebaseAuth;

  const customerA = {
    id: '10000000-0000-4000-8000-000000000001',
    role: 'customer',
    name: 'Customer One',
    countryCode: '+91',
    phone: '9876543210',
    email: 'customer1@example.com',
    authId: 'firebase-uid-cust-1',
  };

  const customerB = {
    id: '20000000-0000-4000-8000-000000000002',
    role: 'customer',
    name: 'Customer Two',
    countryCode: '+91',
    phone: '9876543211',
    email: 'customer2@example.com',
    authId: 'firebase-uid-cust-2',
  };

  const partnerUser = {
    id: '30000000-0000-4000-8000-000000000003',
    role: 'partner',
    name: 'Partner One',
    countryCode: '+91',
    phone: '9876543212',
    email: 'partner@example.com',
    authId: 'firebase-uid-partner',
  };

  const inactiveCustomer = {
    id: '40000000-0000-4000-8000-000000000004',
    role: 'customer',
    name: 'Deactivated User',
    countryCode: '+91',
    phone: '9876543213',
    email: 'inactive@example.com',
    authId: 'firebase-uid-inactive',
  };

  beforeAll(async () => {
    // 1. Initialize in-memory PostgreSQL
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
    await docMigration.up(pgm);

    const adapter = db.adapters.createPg();
    mockPool = new adapter.Pool();

    pool.query = mockPool.query.bind(mockPool);
    pool.connect = mockPool.connect.bind(mockPool);

    // 2. Configure mock Firebase Auth
    mockFirebaseAuth = {
      verifyIdToken: jest.fn().mockImplementation(async (token) => {
        if (token === 'token-customer-1') {
          return { uid: customerA.authId, auth_time: Math.floor(Date.now() / 1000), role: 'customer' };
        }
        if (token === 'token-customer-2') {
          return { uid: customerB.authId, auth_time: Math.floor(Date.now() / 1000), role: 'customer' };
        }
        if (token === 'token-partner') {
          return { uid: partnerUser.authId, auth_time: Math.floor(Date.now() / 1000), role: 'partner' };
        }
        if (token === 'token-inactive') {
          return { uid: inactiveCustomer.authId, auth_time: Math.floor(Date.now() / 1000), role: 'customer' };
        }
        const err = new Error('Invalid token');
        err.code = 'auth/argument-error';
        throw err;
      }),
    };
    setMockFirebaseAuth(mockFirebaseAuth);

    // 3. Seed users
    db.public.none(`
      INSERT INTO users (id, role, name, country_code, phone, email, auth_provider, auth_id, is_active)
      VALUES
        ('${customerA.id}', '${customerA.role}', '${customerA.name}', '${customerA.countryCode}', '${customerA.phone}', '${customerA.email}', 'firebase', '${customerA.authId}', true),
        ('${customerB.id}', '${customerB.role}', '${customerB.name}', '${customerB.countryCode}', '${customerB.phone}', '${customerB.email}', 'firebase', '${customerB.authId}', true),
        ('${partnerUser.id}', '${partnerUser.role}', '${partnerUser.name}', '${partnerUser.countryCode}', '${partnerUser.phone}', '${partnerUser.email}', 'firebase', '${partnerUser.authId}', true),
        ('${inactiveCustomer.id}', '${inactiveCustomer.role}', '${inactiveCustomer.name}', '${inactiveCustomer.countryCode}', '${inactiveCustomer.phone}', '${inactiveCustomer.email}', 'firebase', '${inactiveCustomer.authId}', false);
    `);

    // 4. Seed documents for Customer A only
    db.public.none(`
      INSERT INTO customer_documents (id, user_id, document_type, status, storage_key, metadata, created_at, updated_at)
      VALUES
        ('90000000-0000-4000-8000-000000000001', '${customerA.id}', 'DRIVING_LICENSE', 'VERIFIED', 's3://secure-bucket/private/cust1/dl.jpg', '{"dlNumber": "DL-12345"}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `);

    app = createApp();
  });

  describe('GET /api/v1/customers/me', () => {
    it('1. Authenticated customer can get own profile with verification status', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me')
        .set('Authorization', 'Bearer token-customer-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({
        id: customerA.id,
        role: 'customer',
        name: customerA.name,
        countryCode: customerA.countryCode,
        phone: customerA.phone,
        email: customerA.email,
        verificationStatus: {
          isProfileComplete: true,
          drivingLicenseStatus: 'VERIFIED',
        },
      });

      // Crucial: No auth secrets or DB internals leaked
      expect(res.body.data.authId).toBeUndefined();
      expect(res.body.data.authProvider).toBeUndefined();
    });

    it('2. Unauthenticated request is rejected with 401', async () => {
      const res = await request(app).get('/api/v1/customers/me');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_MISSING_CREDENTIAL');
    });

    it('3. Non-customer role (partner) is rejected with 403', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me')
        .set('Authorization', 'Bearer token-partner');

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('should reject deactivated customer with 403', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me')
        .set('Authorization', 'Bearer token-inactive');

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AUTH_USER_INACTIVE');
    });
  });

  describe('PATCH /api/v1/customers/me', () => {
    it('4. Customer can update allowed fields (name, email)', async () => {
      const res = await request(app)
        .patch('/api/v1/customers/me')
        .set('Authorization', 'Bearer token-customer-1')
        .send({
          name: 'Updated Name',
          email: 'updated.email@example.com',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Updated Name');
      expect(res.body.data.email).toBe('updated.email@example.com');

      // Verify in database
      const row = db.public.one(`SELECT name, email FROM users WHERE id = '${customerA.id}'`);
      expect(row.name).toBe('Updated Name');
      expect(row.email).toBe('updated.email@example.com');
    });

    it('5. Customer cannot change role (mass assignment rejected)', async () => {
      const res = await request(app)
        .patch('/api/v1/customers/me')
        .set('Authorization', 'Bearer token-customer-1')
        .send({
          role: 'admin',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');

      // Role must remain customer in DB
      const row = db.public.one(`SELECT role FROM users WHERE id = '${customerA.id}'`);
      expect(row.role).toBe('customer');
    });

    it('6. Customer cannot change auth_id', async () => {
      const res = await request(app)
        .patch('/api/v1/customers/me')
        .set('Authorization', 'Bearer token-customer-1')
        .send({
          authId: 'attacker-auth-id',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('7. Customer cannot change is_active', async () => {
      const res = await request(app)
        .patch('/api/v1/customers/me')
        .set('Authorization', 'Bearer token-customer-1')
        .send({
          isActive: false,
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('8. Customer cannot change another user profile via client-supplied ID', async () => {
      // Attacker attempts to pass id/userId in body to update customer 2
      const res = await request(app)
        .patch('/api/v1/customers/me')
        .set('Authorization', 'Bearer token-customer-1')
        .send({
          id: customerB.id,
          userId: customerB.id,
          customerId: customerB.id,
          name: 'Hacked Name',
        });

      // Rejected because unknown fields are strictly disallowed
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');

      // Customer 2 in DB remains untouched
      const row = db.public.one(`SELECT name FROM users WHERE id = '${customerB.id}'`);
      expect(row.name).toBe(customerB.name);
    });

    it('9. Unknown fields are rejected', async () => {
      const res = await request(app)
        .patch('/api/v1/customers/me')
        .set('Authorization', 'Bearer token-customer-1')
        .send({
          name: 'Valid Name',
          unknownField: 'malicious-data',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('10. Invalid email is rejected', async () => {
      const res = await request(app)
        .patch('/api/v1/customers/me')
        .set('Authorization', 'Bearer token-customer-1')
        .send({
          email: 'not-an-email',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('11. Invalid name is rejected', async () => {
      const res = await request(app)
        .patch('/api/v1/customers/me')
        .set('Authorization', 'Bearer token-customer-1')
        .send({
          name: 'A', // Too short
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('12. Duplicate email is handled safely with 409 Conflict', async () => {
      // Customer A tries to update email to Customer B's email
      const res = await request(app)
        .patch('/api/v1/customers/me')
        .set('Authorization', 'Bearer token-customer-1')
        .send({
          email: customerB.email,
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('EMAIL_ALREADY_IN_USE');
      expect(res.body.message).toMatch(/already associated with an account/i);
    });

    it('13. SQL injection payloads cannot alter query behavior', async () => {
      const sqlInjectionPayload = "Robert'; DROP TABLE users; --";
      const res = await request(app)
        .patch('/api/v1/customers/me')
        .set('Authorization', 'Bearer token-customer-1')
        .send({
          name: sqlInjectionPayload,
        });

      // Name regex rejects semicolons / dashes
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');

      // Verify table still exists and data intact
      const count = db.public.one('SELECT count(*) FROM users');
      expect(parseInt(count.count, 10)).toBeGreaterThan(0);
    });
  });

  describe('GET /api/v1/customers/me/documents', () => {
    it('14. Customer can retrieve own document metadata', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me/documents')
        .set('Authorization', 'Bearer token-customer-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(1);

      const doc = res.body.data[0];
      expect(doc.documentType).toBe('DRIVING_LICENSE');
      expect(doc.status).toBe('VERIFIED');
      expect(doc.id).toBeDefined();

      // 19. Sensitive storage credentials, keys, or metadata are never returned
      expect(doc.storageKey).toBeUndefined();
      expect(doc.metadata).toBeUndefined();
      expect(doc.s3).toBeUndefined();
    });

    it('15. Unauthenticated document request is rejected with 401', async () => {
      const res = await request(app).get('/api/v1/customers/me/documents');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_MISSING_CREDENTIAL');
    });

    it('16. Non-customer role is rejected with 403', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me/documents')
        .set('Authorization', 'Bearer token-partner');

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('17. Another customer documents cannot be accessed (Customer 2 sees empty list)', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me/documents')
        .set('Authorization', 'Bearer token-customer-2');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]); // Customer 2 has no documents
    });

    it('18. Arbitrary userId/customerId parameters cannot bypass ownership', async () => {
      // Attacker appends query params targeting Customer 1's documents
      const res = await request(app)
        .get(`/api/v1/customers/me/documents?userId=${customerA.id}&customerId=${customerA.id}`)
        .set('Authorization', 'Bearer token-customer-2');

      // Request is still strictly scoped to authenticated user (Customer 2) -> empty list
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });
  });
});
