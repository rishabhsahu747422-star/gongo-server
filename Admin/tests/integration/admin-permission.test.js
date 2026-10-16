'use strict';

const request = require('supertest');
const crypto = require('crypto');


// Mock logger to suppress output
jest.mock('../../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  http: jest.fn(),
}));

const userRepository = require('../../src/repositories/user.repository');
const adminSessionRepository = require('../../src/repositories/admin-session.repository');
const adminPermissionRepository = require('../../src/repositories/admin-permission.repository');
const { hashSessionToken } = require('../../src/utils/crypto');
const { PERMISSIONS } = require('../../src/constants/permissions');
const { createApp } = require('../../src/app');

const app = createApp();

// ── Test Helpers ──────────────────────────────────────────────────────────────

const SUPER_ADMIN_USER = {
  id: 'a0000001-0000-0000-0000-000000000001',
  auth_id: 'sup-super-admin',
  role: 'ADMIN',
  name: 'Super Admin',
  email: 'superadmin@gongo.com',
  is_active: true,
  permissions: [PERMISSIONS.SUPER_ADMIN],
};

const MANAGER_ADMIN_USER = {
  id: 'a0000001-0000-0000-0000-000000000002',
  auth_id: 'sup-manager-admin',
  role: 'ADMIN',
  name: 'Manager Admin',
  email: 'manager@gongo.com',
  is_active: true,
  permissions: [PERMISSIONS.ADMIN_PERMISSIONS_MANAGE, PERMISSIONS.ADMIN_USERS_READ],
};

const LIMITED_ADMIN_USER = {
  id: 'a0000001-0000-0000-0000-000000000003',
  auth_id: 'sup-limited-admin',
  role: 'ADMIN',
  name: 'Limited Admin',
  email: 'limited@gongo.com',
  is_active: true,
  permissions: [PERMISSIONS.CUSTOMERS_READ],
};

const TARGET_ADMIN_USER = {
  id: 'a0000001-0000-0000-0000-000000000004',
  auth_id: 'sup-target-admin',
  role: 'ADMIN',
  name: 'Target Admin',
  email: 'target@gongo.com',
  is_active: true,
};

const CUSTOMER_USER = {
  id: 'c0000001-0000-0000-0000-000000000001',
  auth_id: 'sup-customer',
  role: 'CUSTOMER',
  name: 'Customer User',
  email: 'customer@gongo.com',
  is_active: true,
};

const PARTNER_USER = {
  id: 'b0000001-0000-0000-0000-000000000001',
  auth_id: 'sup-partner',
  role: 'PARTNER',
  name: 'Partner User',
  email: 'partner@gongo.com',
  is_active: true,
};

/**
 * Creates a mock session token and sets up the repository mocks for session auth.
 */
function createMockSession(user) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(rawToken);
  const session = {
    id: `sess-${user.id}`,
    user_id: user.id,
    session_token: tokenHash,
    is_active: true,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    last_active_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  jest.spyOn(adminSessionRepository, 'findByToken').mockImplementation(async (hash) => {
    if (hash === tokenHash) return session;
    return null;
  });

  jest.spyOn(adminSessionRepository, 'touchSession').mockResolvedValue(undefined);

  jest.spyOn(userRepository, 'findById').mockImplementation(async (id) => {
    if (id === user.id) return { ...user };
    if (id === TARGET_ADMIN_USER.id) return { ...TARGET_ADMIN_USER };
    if (id === CUSTOMER_USER.id) return { ...CUSTOMER_USER };
    if (id === PARTNER_USER.id) return { ...PARTNER_USER };
    return null;
  });

  jest.spyOn(adminPermissionRepository, 'findPermissionsByUserId').mockImplementation(async (id) => {
    if (id === user.id) return [...(user.permissions || [])];
    if (id === TARGET_ADMIN_USER.id) return [];
    return [];
  });

  return { rawToken, tokenHash, session };
}

describe('Integration: Admin Permission Management API (Phase 4 — RBAC)', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  describe('1. GET /api/v1/admin/permissions — List Permission Catalog', () => {
    it('returns the canonical permission catalog for authorized admin', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);

      const res = await request(app)
        .get('/api/v1/admin/permissions')
        .set('x-admin-session', rawToken)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.permissions).toBeInstanceOf(Array);
      expect(res.body.data.permissions.length).toBeGreaterThan(0);

      // Verify catalog entries have key and permission fields
      const first = res.body.data.permissions[0];
      expect(first).toHaveProperty('key');
      expect(first).toHaveProperty('permission');
    });

    it('rejects unauthenticated requests', async () => {
      const res = await request(app)
        .get('/api/v1/admin/permissions')
        .expect(401);

      expect(res.body.success).toBe(false);
    });

    it('rejects admin without required permission', async () => {
      const { rawToken } = createMockSession(LIMITED_ADMIN_USER);

      const res = await request(app)
        .get('/api/v1/admin/permissions')
        .set('x-admin-session', rawToken)
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });
  });

  describe('2. GET /api/v1/admin/permissions/:userId — Get User Permissions', () => {
    it('returns permissions for a valid admin target', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);

      const res = await request(app)
        .get(`/api/v1/admin/permissions/${TARGET_ADMIN_USER.id}`)
        .set('x-admin-session', rawToken)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('userId', TARGET_ADMIN_USER.id);
      expect(res.body.data).toHaveProperty('permissions');
    });

    it('rejects invalid UUID in path parameter', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);

      const res = await request(app)
        .get('/api/v1/admin/permissions/not-a-valid-uuid')
        .set('x-admin-session', rawToken)
        .expect(400);

      expect(res.body.success).toBe(false);
    });
  });

  describe('3. POST /api/v1/admin/permissions/grant — Grant Permission', () => {
    it('grants permission when actor has SUPER_ADMIN', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);
      jest.spyOn(adminPermissionRepository, 'assignPermission').mockResolvedValue({ id: 'perm-1' });

      const res = await request(app)
        .post('/api/v1/admin/permissions/grant')
        .set('x-admin-session', rawToken)
        .send({
          targetUserId: TARGET_ADMIN_USER.id,
          permission: PERMISSIONS.CUSTOMERS_READ,
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.granted).toBe(true);
      expect(res.body.data.permission).toBe(PERMISSIONS.CUSTOMERS_READ);
    });

    it('grants permission when actor has admin.permissions.manage', async () => {
      const { rawToken } = createMockSession(MANAGER_ADMIN_USER);
      jest.spyOn(adminPermissionRepository, 'assignPermission').mockResolvedValue({ id: 'perm-2' });

      const res = await request(app)
        .post('/api/v1/admin/permissions/grant')
        .set('x-admin-session', rawToken)
        .send({
          targetUserId: TARGET_ADMIN_USER.id,
          permission: PERMISSIONS.DASHBOARD_READ,
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.granted).toBe(true);
    });

    it('handles idempotent grant (duplicate)', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);
      jest.spyOn(adminPermissionRepository, 'assignPermission').mockResolvedValue(null);

      const res = await request(app)
        .post('/api/v1/admin/permissions/grant')
        .set('x-admin-session', rawToken)
        .send({
          targetUserId: TARGET_ADMIN_USER.id,
          permission: PERMISSIONS.CUSTOMERS_READ,
        })
        .expect(200);

      expect(res.body.data.granted).toBe(false);
    });

    it('rejects unknown permission strings', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);

      const res = await request(app)
        .post('/api/v1/admin/permissions/grant')
        .set('x-admin-session', rawToken)
        .send({
          targetUserId: TARGET_ADMIN_USER.id,
          permission: 'hack.inject.sql',
        })
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it('rejects missing targetUserId', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);

      const res = await request(app)
        .post('/api/v1/admin/permissions/grant')
        .set('x-admin-session', rawToken)
        .send({ permission: PERMISSIONS.CUSTOMERS_READ })
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it('rejects missing permission', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);

      const res = await request(app)
        .post('/api/v1/admin/permissions/grant')
        .set('x-admin-session', rawToken)
        .send({ targetUserId: TARGET_ADMIN_USER.id })
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it('rejects client-supplied identity/role fields (mass assignment)', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);

      const res = await request(app)
        .post('/api/v1/admin/permissions/grant')
        .set('x-admin-session', rawToken)
        .send({
          targetUserId: TARGET_ADMIN_USER.id,
          permission: PERMISSIONS.CUSTOMERS_READ,
          role: 'SUPER_ADMIN',
        })
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it('rejects admin without management permission (privilege escalation)', async () => {
      const { rawToken } = createMockSession(LIMITED_ADMIN_USER);

      const res = await request(app)
        .post('/api/v1/admin/permissions/grant')
        .set('x-admin-session', rawToken)
        .send({
          targetUserId: TARGET_ADMIN_USER.id,
          permission: PERMISSIONS.CUSTOMERS_READ,
        })
        .expect(403);

      expect(res.body.success).toBe(false);
    });

    it('rejects Customer ID as target (BOLA/IDOR — returns 404)', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);

      const res = await request(app)
        .post('/api/v1/admin/permissions/grant')
        .set('x-admin-session', rawToken)
        .send({
          targetUserId: CUSTOMER_USER.id,
          permission: PERMISSIONS.CUSTOMERS_READ,
        })
        .expect(404);

      expect(res.body.success).toBe(false);
    });

    it('rejects Partner ID as target (BOLA/IDOR — returns 404)', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);

      const res = await request(app)
        .post('/api/v1/admin/permissions/grant')
        .set('x-admin-session', rawToken)
        .send({
          targetUserId: PARTNER_USER.id,
          permission: PERMISSIONS.CUSTOMERS_READ,
        })
        .expect(404);

      expect(res.body.success).toBe(false);
    });

    it('rejects nonexistent target user (returns 404)', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);

      const res = await request(app)
        .post('/api/v1/admin/permissions/grant')
        .set('x-admin-session', rawToken)
        .send({
          targetUserId: 'a0000099-0000-0000-0000-000000000099',
          permission: PERMISSIONS.CUSTOMERS_READ,
        })
        .expect(404);

      expect(res.body.success).toBe(false);
    });
  });

  describe('4. POST /api/v1/admin/permissions/revoke — Revoke Permission', () => {
    it('revokes permission when actor has SUPER_ADMIN', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);
      jest.spyOn(adminPermissionRepository, 'revokePermission').mockResolvedValue(true);

      const res = await request(app)
        .post('/api/v1/admin/permissions/revoke')
        .set('x-admin-session', rawToken)
        .send({
          targetUserId: TARGET_ADMIN_USER.id,
          permission: PERMISSIONS.CUSTOMERS_READ,
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.revoked).toBe(true);
    });

    it('handles revocation of missing permission gracefully', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);
      jest.spyOn(adminPermissionRepository, 'revokePermission').mockResolvedValue(false);

      const res = await request(app)
        .post('/api/v1/admin/permissions/revoke')
        .set('x-admin-session', rawToken)
        .send({
          targetUserId: TARGET_ADMIN_USER.id,
          permission: PERMISSIONS.CUSTOMERS_READ,
        })
        .expect(200);

      expect(res.body.data.revoked).toBe(false);
    });

    it('rejects admin without management permission', async () => {
      const { rawToken } = createMockSession(LIMITED_ADMIN_USER);

      const res = await request(app)
        .post('/api/v1/admin/permissions/revoke')
        .set('x-admin-session', rawToken)
        .send({
          targetUserId: TARGET_ADMIN_USER.id,
          permission: PERMISSIONS.CUSTOMERS_READ,
        })
        .expect(403);

      expect(res.body.success).toBe(false);
    });
  });

  describe('5. Security: Self-Escalation & Self-Lockout Prevention', () => {
    it('prevents self-escalation: cannot grant self a permission not already possessed', async () => {
      // Manager admin tries to grant themselves SUPER_ADMIN
      const managerUser = { ...MANAGER_ADMIN_USER };
      const { rawToken } = createMockSession(managerUser);

      // Override findById to return manager as target
      jest.spyOn(userRepository, 'findById').mockImplementation(async (id) => {
        if (id === managerUser.id) return { ...managerUser };
        return null;
      });

      const res = await request(app)
        .post('/api/v1/admin/permissions/grant')
        .set('x-admin-session', rawToken)
        .send({
          targetUserId: managerUser.id,
          permission: PERMISSIONS.SUPER_ADMIN,
        })
        .expect(403);

      expect(res.body.success).toBe(false);
    });

    it('prevents self-lockout: cannot revoke own admin.permissions.manage', async () => {
      const managerUser = { ...MANAGER_ADMIN_USER };
      const { rawToken } = createMockSession(managerUser);

      jest.spyOn(userRepository, 'findById').mockImplementation(async (id) => {
        if (id === managerUser.id) return { ...managerUser };
        return null;
      });

      const res = await request(app)
        .post('/api/v1/admin/permissions/revoke')
        .set('x-admin-session', rawToken)
        .send({
          targetUserId: managerUser.id,
          permission: PERMISSIONS.ADMIN_PERMISSIONS_MANAGE,
        })
        .expect(403);

      expect(res.body.success).toBe(false);
    });

    it('prevents self-lockout: cannot revoke own SUPER_ADMIN', async () => {
      const superUser = { ...SUPER_ADMIN_USER };
      const { rawToken } = createMockSession(superUser);

      jest.spyOn(userRepository, 'findById').mockImplementation(async (id) => {
        if (id === superUser.id) return { ...superUser };
        return null;
      });

      const res = await request(app)
        .post('/api/v1/admin/permissions/revoke')
        .set('x-admin-session', rawToken)
        .send({
          targetUserId: superUser.id,
          permission: PERMISSIONS.SUPER_ADMIN,
        })
        .expect(403);

      expect(res.body.success).toBe(false);
    });
  });

  describe('6. Security: Header/Body Permission Injection', () => {
    it('rejects x-role header bypass attempts', async () => {
      const res = await request(app)
        .get('/api/v1/admin/permissions')
        .set('x-role', 'SUPER_ADMIN')
        .expect(401);

      expect(res.body.success).toBe(false);
    });

    it('rejects x-admin bypass header', async () => {
      const res = await request(app)
        .get('/api/v1/admin/permissions')
        .set('x-admin', 'true')
        .expect(401);

      expect(res.body.success).toBe(false);
    });

    it('rejects body-injected permissions field', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);

      const res = await request(app)
        .post('/api/v1/admin/permissions/grant')
        .set('x-admin-session', rawToken)
        .send({
          targetUserId: TARGET_ADMIN_USER.id,
          permission: PERMISSIONS.CUSTOMERS_READ,
          permissions: ['SUPER_ADMIN'],
        })
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it('rejects body-injected userId field', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);

      const res = await request(app)
        .post('/api/v1/admin/permissions/grant')
        .set('x-admin-session', rawToken)
        .send({
          targetUserId: TARGET_ADMIN_USER.id,
          permission: PERMISSIONS.CUSTOMERS_READ,
          userId: SUPER_ADMIN_USER.id,
        })
        .expect(400);

      expect(res.body.success).toBe(false);
    });
  });

  describe('7. Response Format', () => {
    it('uses standardized success envelope', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);

      const res = await request(app)
        .get('/api/v1/admin/permissions')
        .set('x-admin-session', rawToken)
        .expect(200);

      expect(res.body).toHaveProperty('success', true);
      expect(res.body).toHaveProperty('data');
    });

    it('uses standardized error envelope with safe messages', async () => {
      const res = await request(app)
        .get('/api/v1/admin/permissions')
        .expect(401);

      expect(res.body).toHaveProperty('success', false);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toHaveProperty('code');
      expect(res.body.error).toHaveProperty('message');
      // Must not leak internal details
      expect(JSON.stringify(res.body)).not.toMatch(/sql|query|pg_|SELECT|INSERT/i);
    });
  });
});
