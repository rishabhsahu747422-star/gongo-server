'use strict';

const request = require('supertest');
const crypto = require('crypto');


// Mock logger to suppress console noise
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
const auditService = require('../../src/services/audit.service');
const { hashSessionToken } = require('../../src/utils/crypto');
const { PERMISSIONS } = require('../../src/constants/permissions');
const { createApp } = require('../../src/app');

const app = createApp();

// ── Test User Fixtures ────────────────────────────────────────────────────────

const SUPER_ADMIN_USER = {
  id: 'a0000001-0000-4000-a000-000000000001',
  auth_id: 'sup-super-admin',
  role: 'ADMIN',
  name: 'Super Admin',
  email: 'superadmin@gongo.in',
  country_code: '+91',
  phone: '9876543210',
  is_active: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  permissions: [PERMISSIONS.SUPER_ADMIN],
};

const OTHER_ADMIN_USER = {
  id: 'a0000001-0000-4000-a000-000000000002',
  auth_id: 'sup-other-admin',
  role: 'ADMIN',
  name: 'Other Admin',
  email: 'otheradmin@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.DASHBOARD_READ],
};

const DEACTIVATED_ADMIN_USER = {
  id: 'a0000001-0000-4000-a000-000000000003',
  auth_id: 'sup-deactivated-admin',
  role: 'ADMIN',
  name: 'Deactivated Admin',
  email: 'deactivated@gongo.in',
  is_active: false,
};

const CUSTOMER_USER = {
  id: 'c0000001-0000-4000-a000-000000000001',
  auth_id: 'sup-customer',
  role: 'CUSTOMER',
  name: 'Customer User',
  email: 'customer@gongo.in',
  is_active: true,
};

const PARTNER_USER = {
  id: 'b0000001-0000-4000-a000-000000000001',
  auth_id: 'sup-partner',
  role: 'PARTNER',
  name: 'Partner User',
  email: 'partner@gongo.in',
  is_active: true,
};

/**
 * Creates a mock session token and sets up the repository mocks.
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
    ip_address: '127.0.0.1',
    user_agent: 'Jest/Supertest',
  };

  jest.spyOn(adminSessionRepository, 'findByToken').mockImplementation(async (hash) => {
    if (hash === tokenHash) return session;
    return null;
  });

  jest.spyOn(adminSessionRepository, 'touchSession').mockResolvedValue(true);

  jest.spyOn(userRepository, 'findById').mockImplementation(async (id) => {
    if (id === user.id) return { ...user };
    if (id === OTHER_ADMIN_USER.id) return { ...OTHER_ADMIN_USER };
    if (id === CUSTOMER_USER.id) return { ...CUSTOMER_USER };
    if (id === PARTNER_USER.id) return { ...PARTNER_USER };
    return null;
  });

  jest.spyOn(adminPermissionRepository, 'findPermissionsByUserId').mockImplementation(async (id) => {
    if (id === user.id) return [...(user.permissions || [])];
    return [];
  });

  jest.spyOn(adminSessionRepository, 'countActiveSessionsByUserId').mockResolvedValue(1);

  return { rawToken, tokenHash, session };
}

describe('Integration: Admin Profile & Account Security (Phase 5)', () => {
  let auditLogs;

  beforeEach(() => {
    jest.restoreAllMocks();
    auditLogs = [];
    jest.spyOn(auditService, 'logAdminAction').mockImplementation((event) => {
      auditLogs.push(event);
      return event;
    });
  });

  describe('1. GET /api/v1/admin/profile — Profile Retrieval', () => {
    it('retrieves profile with safe fields and active session summary', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);

      const res = await request(app)
        .get('/api/v1/admin/profile')
        .set('x-admin-session', rawToken)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('id', SUPER_ADMIN_USER.id);
      expect(res.body.data).toHaveProperty('name', SUPER_ADMIN_USER.name);
      expect(res.body.data).toHaveProperty('email', SUPER_ADMIN_USER.email);
      expect(res.body.data).toHaveProperty('role', 'ADMIN');
      expect(res.body.data).toHaveProperty('is_active', true);
      expect(res.body.data).toHaveProperty('permissions');
      expect(res.body.data).toHaveProperty('security');
      expect(res.body.data.security).toHaveProperty('activeSessionsCount', 1);

      // Verify absence of sensitive credentials
      expect(res.body.data).not.toHaveProperty('password');
      expect(res.body.data).not.toHaveProperty('session_token');
      expect(res.body.data).not.toHaveProperty('auth_id');
      expect(res.body.data).not.toHaveProperty('sup_uid');
    });

    it('rejects unauthenticated profile request with 401', async () => {
      const res = await request(app)
        .get('/api/v1/admin/profile')
        .expect(401);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('AUTH_REQUIRED');
    });

    it('rejects Customer user with 403 Forbidden', async () => {
      const { rawToken } = createMockSession(CUSTOMER_USER);

      const res = await request(app)
        .get('/api/v1/admin/profile')
        .set('x-admin-session', rawToken)
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('rejects Partner user with 403 Forbidden', async () => {
      const { rawToken } = createMockSession(PARTNER_USER);

      const res = await request(app)
        .get('/api/v1/admin/profile')
        .set('x-admin-session', rawToken)
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('rejects deactivated Admin with 403 ACCOUNT_DEACTIVATED', async () => {
      const { rawToken } = createMockSession(DEACTIVATED_ADMIN_USER);

      const res = await request(app)
        .get('/api/v1/admin/profile')
        .set('x-admin-session', rawToken)
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('ACCOUNT_DEACTIVATED');
    });
  });

  describe('2. PATCH /api/v1/admin/profile — Profile Mutation', () => {
    it('updates name successfully and creates audit log', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);
      jest.spyOn(userRepository, 'updateProfile').mockResolvedValue({
        ...SUPER_ADMIN_USER,
        name: 'New Admin Name',
        updated_at: new Date().toISOString(),
      });

      const res = await request(app)
        .patch('/api/v1/admin/profile')
        .set('x-admin-session', rawToken)
        .send({ name: 'New Admin Name' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('New Admin Name');
      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0]).toMatchObject({
        action: 'PROFILE_UPDATED',
        actorId: SUPER_ADMIN_USER.id,
        targetResource: 'USER',
        targetResourceId: SUPER_ADMIN_USER.id,
      });
    });

    it('updates phone and country_code successfully', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);
      jest.spyOn(userRepository, 'updateProfile').mockResolvedValue({
        ...SUPER_ADMIN_USER,
        phone: '9988776655',
        country_code: '+91',
      });

      const res = await request(app)
        .patch('/api/v1/admin/profile')
        .set('x-admin-session', rawToken)
        .send({ phone: '9988776655', country_code: '+91' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.phone).toBe('9988776655');
      expect(res.body.data.country_code).toBe('+91');
    });

    it('rejects email modification with 400', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);

      const res = await request(app)
        .patch('/api/v1/admin/profile')
        .set('x-admin-session', rawToken)
        .send({ email: 'hacked@gongo.in' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects role escalation attempt with 400', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);

      const res = await request(app)
        .patch('/api/v1/admin/profile')
        .set('x-admin-session', rawToken)
        .send({ role: 'SUPER_ADMIN', name: 'Valid Name' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects is_active tampering with 400', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);

      const res = await request(app)
        .patch('/api/v1/admin/profile')
        .set('x-admin-session', rawToken)
        .send({ is_active: false, name: 'Valid Name' })
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it('rejects permissions injection with 400', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);

      const res = await request(app)
        .patch('/api/v1/admin/profile')
        .set('x-admin-session', rawToken)
        .send({ permissions: ['SUPER_ADMIN'], name: 'Valid Name' })
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it('rejects client-supplied userId / target tampering with 400', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);

      const res = await request(app)
        .patch('/api/v1/admin/profile')
        .set('x-admin-session', rawToken)
        .send({ userId: OTHER_ADMIN_USER.id, name: 'Valid Name' })
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it('rejects unexpected fields with 400', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);

      const res = await request(app)
        .patch('/api/v1/admin/profile')
        .set('x-admin-session', rawToken)
        .send({ arbitraryKey: 'malicious' })
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it('rejects empty body with 400', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);

      const res = await request(app)
        .patch('/api/v1/admin/profile')
        .set('x-admin-session', rawToken)
        .send({})
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it('rejects oversized name with 400', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);

      const res = await request(app)
        .patch('/api/v1/admin/profile')
        .set('x-admin-session', rawToken)
        .send({ name: 'A'.repeat(105) })
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it('rejects script tags in name with 400', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);

      const res = await request(app)
        .patch('/api/v1/admin/profile')
        .set('x-admin-session', rawToken)
        .send({ name: '<script>alert(1)</script>' })
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it('rejects malformed phone number with 400', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);

      const res = await request(app)
        .patch('/api/v1/admin/profile')
        .set('x-admin-session', rawToken)
        .send({ phone: '123' })
        .expect(400);

      expect(res.body.success).toBe(false);
    });
  });

  describe('3. GET /api/v1/admin/profile/sessions — Session Visibility', () => {
    it('returns active sessions for authenticated admin without leaking tokens', async () => {
      const { rawToken, tokenHash } = createMockSession(SUPER_ADMIN_USER);
      const mockSessions = [
        {
          id: 'sess-current',
          session_token: tokenHash,
          ip_address: '127.0.0.1',
          user_agent: 'Jest',
          created_at: '2026-01-01T00:00:00.000Z',
          expires_at: '2026-01-02T00:00:00.000Z',
          last_active_at: '2026-01-01T01:00:00.000Z',
        },
        {
          id: 'sess-other-device',
          session_token: 'hash-other',
          ip_address: '10.0.0.1',
          user_agent: 'Mobile',
          created_at: '2026-01-01T00:00:00.000Z',
          expires_at: '2026-01-02T00:00:00.000Z',
          last_active_at: '2026-01-01T01:00:00.000Z',
        },
      ];
      jest.spyOn(adminSessionRepository, 'findActiveSessionsByUserId').mockResolvedValue(mockSessions);

      const res = await request(app)
        .get('/api/v1/admin/profile/sessions')
        .set('x-admin-session', rawToken)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.sessions).toHaveLength(2);
      expect(res.body.data.sessions[0].id).toBe('sess-current');
      expect(res.body.data.sessions[0].is_current).toBe(true);
      expect(res.body.data.sessions[1].is_current).toBe(false);

      // Verify absence of session tokens in response
      expect(res.body.data.sessions[0]).not.toHaveProperty('session_token');
      expect(res.body.data.sessions[1]).not.toHaveProperty('session_token');
    });

    it('rejects unauthenticated session query with 401', async () => {
      const res = await request(app)
        .get('/api/v1/admin/profile/sessions')
        .expect(401);

      expect(res.body.success).toBe(false);
    });
  });

  describe('4. DELETE /api/v1/admin/profile/sessions/:sessionId — Session Revocation', () => {
    it('revokes an owned session successfully and audits action', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);
      jest.spyOn(adminSessionRepository, 'findSessionByIdForUser').mockResolvedValue({
        id: 'sess-target-to-revoke',
        user_id: SUPER_ADMIN_USER.id,
        is_active: true,
        session_token: 'hash-target',
      });
      jest.spyOn(adminSessionRepository, 'revokeSessionByIdForUser').mockResolvedValue(true);

      const res = await request(app)
        .delete('/api/v1/admin/profile/sessions/sess-target-to-revoke')
        .set('x-admin-session', rawToken)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.revoked).toBe(true);
      expect(res.body.data.sessionId).toBe('sess-target-to-revoke');

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0]).toMatchObject({
        action: 'ADMIN_SESSION_REVOKED',
        actorId: SUPER_ADMIN_USER.id,
        targetResource: 'ADMIN_SESSION',
        targetResourceId: 'sess-target-to-revoke',
      });
    });

    it('prevents BOLA: returns 404 when attempting to revoke another admin session', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);
      // findSessionByIdForUser returns null when session does not belong to the user
      jest.spyOn(adminSessionRepository, 'findSessionByIdForUser').mockResolvedValue(null);

      const res = await request(app)
        .delete('/api/v1/admin/profile/sessions/sess-belonging-to-other-admin')
        .set('x-admin-session', rawToken)
        .expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 for nonexistent session ID', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);
      jest.spyOn(adminSessionRepository, 'findSessionByIdForUser').mockResolvedValue(null);

      const res = await request(app)
        .delete('/api/v1/admin/profile/sessions/nonexistent-session')
        .set('x-admin-session', rawToken)
        .expect(404);

      expect(res.body.success).toBe(false);
    });
  });

  describe('5. Security: Header Manipulation Bypasses', () => {
    it('rejects x-role header bypass attempts', async () => {
      const res = await request(app)
        .get('/api/v1/admin/profile')
        .set('x-role', 'SUPER_ADMIN')
        .expect(401);

      expect(res.body.success).toBe(false);
    });

    it('rejects x-admin bypass header', async () => {
      const res = await request(app)
        .get('/api/v1/admin/profile')
        .set('x-admin', 'true')
        .expect(401);

      expect(res.body.success).toBe(false);
    });
  });
});
