'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const adminCredentialRepository = require('../../src/repositories/admin-credential.repository');
const { installTokenSessions } = require('../support/token-sessions');
const userRepository = require('../../src/repositories/user.repository');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('E2E Integration: POST /api/v1/admin/users Authentication & RBAC Flow', () => {
  let app;
  let inMemoryUsers;
  let uninstallSessions;
  let credentialWrites;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    inMemoryUsers = new Map();

    const ADMIN_USER = {
      id: 'admin-uuid-001',
      name: 'Lead Operations Admin',
      email: 'admin@gongo.com',
      role: 'ADMIN',
      status: 'active',
      is_active: true,
      permissions: ['SUPER_ADMIN', 'USERS_MANAGE'],
    };
    const CUSTOMER_USER = {
      id: 'cust-uuid-001',
      name: 'Regular Customer',
      email: 'customer@gongo.com',
      role: 'CUSTOMER',
      status: 'active',
      is_active: true,
    };
    // Bearer tokens are server-side admin sessions (the only credential the Admin API accepts)
    uninstallSessions = installTokenSessions({
      'valid-admin-supabase-token': { user: ADMIN_USER },
      'valid-customer-supabase-token': { user: CUSTOMER_USER },
      'expired-supabase-token': { user: ADMIN_USER, expired: true },
    });
    credentialWrites = [];
    jest.spyOn(adminCredentialRepository, 'createIfAbsent').mockImplementation(async (row) => {
      credentialWrites.push(row);
      return true;
    });

    userRepository.constructor.setMockUserResolver((identifier) => {
      if (identifier === 'sup-admin-uid-1' || identifier === 'admin@gongo.com') {
        return {
          id: 'admin-uuid-001',
          auth_id: 'sup-admin-uid-1',
          name: 'Lead Operations Admin',
          email: 'admin@gongo.com',
          role: 'ADMIN',
          status: 'active',
          is_active: true,
          permissions: ['SUPER_ADMIN', 'USERS_MANAGE'],
        };
      }
      if (identifier === 'sup-customer-uid-1' || identifier === 'customer@gongo.com') {
        return {
          id: 'cust-uuid-001',
          auth_id: 'sup-customer-uid-1',
          name: 'Regular Customer',
          email: 'customer@gongo.com',
          role: 'CUSTOMER',
          status: 'active',
          is_active: true,
        };
      }
      return null;
    });
  });

  afterEach(() => {
    uninstallSessions();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    userRepository.constructor.resetMockUserResolver();
  });

  // Test A: No token -> 401
  describe('Test A — No token', () => {
    it('rejects unauthenticated request with HTTP 401', async () => {
      const res = await request(app)
        .post('/api/v1/admin/users')
        .send({
          name: 'New Admin',
          email: 'newadmin@gongo.com',
          role: 'admin',
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(ERROR_CODES.AUTH_REQUIRED);
    });
  });

  // Test B: Invalid token -> 401 INVALID_TOKEN
  describe('Test B — Invalid token', () => {
    it('rejects forged / bogus token with 401 INVALID_TOKEN', async () => {
      const res = await request(app)
        .post('/api/v1/admin/users')
        .set('Authorization', 'Bearer invalid-forged-token-xyz')
        .send({
          name: 'New Admin',
          email: 'newadmin@gongo.com',
          role: 'admin',
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.INVALID_TOKEN);
      expect(res.body.error.message).toBe('Invalid session token');
    });

    it('rejects wrong Supabase project token with 401 INVALID_TOKEN', async () => {
      const res = await request(app)
        .post('/api/v1/admin/users')
        .set('Authorization', 'Bearer wrong-project-token')
        .send({
          name: 'New Admin',
          email: 'newadmin@gongo.com',
          role: 'admin',
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.INVALID_TOKEN);
    });
  });

  // Test C: Expired token -> 401 INVALID_TOKEN / TOKEN_EXPIRED
  describe('Test C — Expired token', () => {
    it('rejects expired Supabase token with 401 status code', async () => {
      const res = await request(app)
        .post('/api/v1/admin/users')
        .set('Authorization', 'Bearer expired-supabase-token')
        .send({
          name: 'New Admin',
          email: 'newadmin@gongo.com',
          role: 'admin',
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect([ERROR_CODES.INVALID_TOKEN, ERROR_CODES.TOKEN_EXPIRED]).toContain(res.body.error.code);
    });
  });

  // Test D: Valid Supabase token + non-admin -> 403
  describe('Test D — Valid Supabase token + non-admin', () => {
    it('rejects valid Supabase token from non-admin customer with HTTP 403 Forbidden', async () => {
      const res = await request(app)
        .post('/api/v1/admin/users')
        .set('Authorization', 'Bearer valid-customer-supabase-token')
        .send({
          name: 'New Admin',
          email: 'newadmin@gongo.com',
          role: 'admin',
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });
  });

    // Test E: Valid Supabase token + Admin -> Successful API response
  describe('Test E — Valid Supabase token + Admin', () => {
    it('successfully creates an admin user with role: admin', async () => {
      const res = await request(app)
        .post('/api/v1/admin/users')
        .set('Authorization', 'Bearer valid-admin-supabase-token')
        .send({
          name: 'Sarah Connor',
          email: 'sarah.connor@gongo.com',
          role: 'admin',
          phone: '9876500001',
          password: 'Initial-Pass-2026',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.name).toBe('Sarah Connor');
      expect(res.body.data.email).toBe('sarah.connor@gongo.com');
      expect(res.body.data.role).toBe('admin');
      expect(res.body.data.status).toBe('active');

      // Initial password is stored only as a scrypt hash and must be changed at first login
      expect(credentialWrites).toHaveLength(1);
      expect(credentialWrites[0].passwordHash).toMatch(/^scrypt\$/);
      expect(credentialWrites[0].passwordHash).not.toContain('Initial-Pass-2026');
      expect(credentialWrites[0].mustChangePassword).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain('Initial-Pass-2026');
    });

    it('rejects an initial password that does not meet the password policy', async () => {
      const res = await request(app)
        .post('/api/v1/admin/users')
        .set('Authorization', 'Bearer valid-admin-supabase-token')
        .send({
          name: 'Weak', email: 'weak@gongo.com', role: 'admin', password: 'password1',
        });
      expect(res.status).toBe(400);
      expect(credentialWrites).toHaveLength(0);
    });

    it('successfully creates an admin user with role: super_admin', async () => {
      const res = await request(app)
        .post('/api/v1/admin/users')
        .set('Authorization', 'Bearer valid-admin-supabase-token')
        .send({
          name: 'Super Admin User',
          email: 'superadmin.new@gongo.com',
          role: 'super_admin',
          phone: '9876500002',
          password: 'Initial-Pass-2026',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.role).toBe('super_admin');
    });

    it('successfully creates an admin user with role: support_executive', async () => {
      const res = await request(app)
        .post('/api/v1/admin/users')
        .set('Authorization', 'Bearer valid-admin-supabase-token')
        .send({
          name: 'Support Agent User',
          email: 'support.new@gongo.com',
          role: 'support_executive',
          phone: '9876500003',
          password: 'Initial-Pass-2026',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.role).toBe('support_executive');
    });

    it('rejects creation without an initial password (no shared default password)', async () => {
      const res = await request(app)
        .post('/api/v1/admin/users')
        .set('Authorization', 'Bearer valid-admin-supabase-token')
        .send({
          name: 'No Password User',
          email: 'nopassword.new@gongo.com',
          role: 'admin',
          phone: '9876500004',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects invalid role with HTTP 400 validation error', async () => {
      const res = await request(app)
        .post('/api/v1/admin/users')
        .set('Authorization', 'Bearer valid-admin-supabase-token')
        .send({
          name: 'Invalid Role User',
          email: 'invalid.role@gongo.com',
          role: 'OPERATIONS_ADMIN',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('Allowed values: admin, super_admin, support_executive');
    });

    it('rejects duplicate admin creation with validation error', async () => {
      const duplicatePayload = {
        name: 'Duplicate Admin',
        email: 'admin@gongo.com', // Already registered admin
        role: 'admin',
      };

      const res = await request(app)
        .post('/api/v1/admin/users')
        .set('Authorization', 'Bearer valid-admin-supabase-token')
        .send(duplicatePayload);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('retrieves the admin users list successfully via GET /api/v1/admin/users', async () => {
      const res = await request(app)
        .get('/api/v1/admin/users')
        .set('Authorization', 'Bearer valid-admin-supabase-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });
});
