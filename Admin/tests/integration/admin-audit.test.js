'use strict';

const request = require('supertest');


// Mock logger
jest.mock('../../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  http: jest.fn(),
}));

const userRepository = require('../../src/repositories/user.repository');
const adminSessionRepository = require('../../src/repositories/admin-session.repository');
const adminActionRepository = require('../../src/repositories/admin-action.repository');
const { hashSessionToken } = require('../../src/utils/crypto');
const { PERMISSIONS } = require('../../src/constants/permissions');
const { UnauthorizedError } = require('../../src/errors');
const { createApp } = require('../../src/app');

const app = createApp();

// ── Test User Fixtures ────────────────────────────────────────────────────────

const SUPER_ADMIN_USER = {
  id: 'a0000001-0000-4000-a000-000000000001',
  auth_id: 'sup-super-admin',
  role: 'ADMIN',
  name: 'Super Admin',
  email: 'superadmin@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.SUPER_ADMIN],
};

const AUDIT_READ_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000002',
  auth_id: 'sup-audit-read-admin',
  role: 'ADMIN',
  name: 'Audit Read Admin',
  email: 'auditread@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.AUDIT_READ],
};

const SECURITY_READ_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000003',
  auth_id: 'sup-security-read-admin',
  role: 'ADMIN',
  name: 'Security Read Admin',
  email: 'securityread@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.AUDIT_SECURITY_READ],
};

const NO_PERM_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000004',
  auth_id: 'sup-noperm-admin',
  role: 'ADMIN',
  name: 'No Perm Admin',
  email: 'noperm@gongo.in',
  is_active: true,
  permissions: [],
};

const DEACTIVATED_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000005',
  auth_id: 'sup-deactivated-admin',
  role: 'ADMIN',
  name: 'Deactivated Admin',
  email: 'deactivated@gongo.in',
  is_active: false,
  permissions: [PERMISSIONS.SUPER_ADMIN],
};

const NON_ADMIN_CUSTOMER = {
  id: 'c0000001-0000-4000-a000-000000000001',
  auth_id: 'sup-customer-user',
  role: 'CUSTOMER',
  name: 'Customer User',
  email: 'customer@gmail.com',
  is_active: true,
  permissions: [],
};

const TEST_AUDIT_ID = 'da000001-0000-4000-a000-000000000001';
const TEST_BOOKING_ID = 'b0000001-0000-4000-a000-000000000001';

const SESSIONS = {
  superAdmin: 'sess_superadmin_audit_token_001',
  auditRead: 'sess_auditread_audit_token_002',
  securityRead: 'sess_securityread_audit_token_003',
  noPerm: 'sess_noperm_audit_token_004',
  deactivated: 'sess_deactivated_audit_token_005',
  customer: 'sess_customer_audit_token_006',
};

describe('Integration: Admin Audit & Security Monitoring (Phase 17)', () => {
  beforeEach(() => {
    jest.spyOn(adminSessionRepository, 'findByToken').mockImplementation(async (tokenHash) => {
      const match = Object.entries(SESSIONS).find(
        ([, rawToken]) => hashSessionToken(rawToken) === tokenHash,
      );
      if (!match) return null;
      const key = match[0];
      const userMap = {
        superAdmin: SUPER_ADMIN_USER,
        auditRead: AUDIT_READ_ADMIN,
        securityRead: SECURITY_READ_ADMIN,
        noPerm: NO_PERM_ADMIN,
        deactivated: DEACTIVATED_ADMIN,
        customer: NON_ADMIN_CUSTOMER,
      };
      const user = userMap[key];
      if (!user) return null;

      return {
        id: `sess-${key}-id`,
        user_id: user.id,
        is_active: true,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        last_active_at: new Date().toISOString(),
      };
    });

    jest.spyOn(userRepository, 'findById').mockImplementation(async (userId) => {
      const users = [
        SUPER_ADMIN_USER,
        AUDIT_READ_ADMIN,
        SECURITY_READ_ADMIN,
        NO_PERM_ADMIN,
        DEACTIVATED_ADMIN,
        NON_ADMIN_CUSTOMER,
      ];
      return users.find((u) => u.id === userId) || null;
    });

    // Mock query on adminActionRepository
    adminActionRepository.query = jest.fn();
    adminActionRepository.constructor.resetMockActionResolver();

  });

  afterEach(() => {
    jest.restoreAllMocks();
    adminActionRepository.constructor.resetMockActionResolver();
  });

  // ── 1. Authentication & RBAC Guard Tests ────────────────────────────────────

  describe('1. Authentication & RBAC Access Control', () => {
    it('returns 401 when no session token is provided', async () => {
      const res = await request(app).get('/api/v1/admin/audit');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 401 when invalid session token is provided', async () => {
      const res = await request(app)
        .get('/api/v1/admin/audit')
        .set('Authorization', 'Bearer invalid-token-xyz');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 403 when admin user is deactivated', async () => {
      const res = await request(app)
        .get('/api/v1/admin/audit')
        .set('Authorization', `Bearer ${SESSIONS.deactivated}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('returns 403 when authenticated user is not an ADMIN role (e.g. CUSTOMER)', async () => {
      const res = await request(app)
        .get('/api/v1/admin/audit')
        .set('Authorization', `Bearer ${SESSIONS.customer}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('returns 403 when admin user lacks audit.read permission', async () => {
      const res = await request(app)
        .get('/api/v1/admin/audit')
        .set('Authorization', `Bearer ${SESSIONS.noPerm}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('returns 200 when admin has audit.read permission', async () => {
      adminActionRepository.query
        .mockResolvedValueOnce({ rows: [{ total: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get('/api/v1/admin/audit')
        .set('Authorization', `Bearer ${SESSIONS.auditRead}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    it('returns 200 when admin has audit.security.read permission', async () => {
      adminActionRepository.query
        .mockResolvedValueOnce({ rows: [{ total: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get('/api/v1/admin/audit')
        .set('Authorization', `Bearer ${SESSIONS.securityRead}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 200 when user is SUPER_ADMIN (permission bypass)', async () => {
      adminActionRepository.query
        .mockResolvedValueOnce({ rows: [{ total: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get('/api/v1/admin/audit')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ── 2. Audit Listing Endpoints ──────────────────────────────────────────────

  describe('2. GET /api/v1/admin/audit and /api/v1/admin/audit-logs', () => {
    it('returns paginated audit records with safe projections via canonical and alias routes', async () => {
      const mockRow = {
        id: TEST_AUDIT_ID,
        actor_id: SUPER_ADMIN_USER.id,
        actor_role: 'ADMIN',
        permission: 'audit.read',
        action: 'ADMIN_LOGIN',
        target_resource: 'ADMIN_SESSION',
        target_resource_id: 'sess-100',
        request_id: 'req-001',
        ip_address: '127.0.0.1',
        user_agent: 'JestAgent',
        before_state: null,
        after_state: null,
        metadata: { info: 'login ok' },
        created_at: new Date('2026-09-01T10:00:00Z'),
        actor_name: 'Super Admin',
        actor_email: 'superadmin@gongo.in',
      };

      // 1. Canonical route
      adminActionRepository.query
        .mockResolvedValueOnce({ rows: [{ total: '1' }] })
        .mockResolvedValueOnce({ rows: [mockRow] });

      const res1 = await request(app)
        .get('/api/v1/admin/audit?page=1&limit=10')
        .set('Authorization', `Bearer ${SESSIONS.auditRead}`);

      expect(res1.status).toBe(200);
      expect(res1.body.success).toBe(true);
      expect(res1.body.data).toHaveLength(1);
      expect(res1.body.data[0].id).toBe(TEST_AUDIT_ID);
      expect(res1.body.data[0].actor.name).toBe('Super Admin');
      expect(res1.body.meta.total).toBe(1);

      // 2. Alias route /audit-logs
      adminActionRepository.query
        .mockResolvedValueOnce({ rows: [{ total: '1' }] })
        .mockResolvedValueOnce({ rows: [mockRow] });

      const res2 = await request(app)
        .get('/api/v1/admin/audit-logs?page=1&limit=10')
        .set('Authorization', `Bearer ${SESSIONS.auditRead}`);

      expect(res2.status).toBe(200);
      expect(res2.body.success).toBe(true);
      expect(res2.body.data).toHaveLength(1);
    });

    it('filters by actorId, action, targetResource, requestId, ipAddress, category, search', async () => {
      adminActionRepository.query
        .mockResolvedValueOnce({ rows: [{ total: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get('/api/v1/admin/audit')
        .query({
          actorId: SUPER_ADMIN_USER.id,
          action: 'CANCEL_BOOKING',
          targetResource: 'BOOKING',
          requestId: 'req-002',
          ipAddress: '10.0.0.1',
          category: 'AUTHENTICATION',
          search: 'booking-search',
        })
        .set('Authorization', `Bearer ${SESSIONS.auditRead}`);

      expect(res.status).toBe(200);
      expect(adminActionRepository.query).toHaveBeenCalledTimes(2);
      const [sql, values] = adminActionRepository.query.mock.calls[0];
      expect(sql).toContain('a.actor_id = $');
      expect(sql).toContain('a.action = $');
      expect(sql).toContain('a.target_resource = $');
      expect(sql).toContain('a.request_id = $');
      expect(sql).toContain('a.ip_address = $');
      expect(sql).toContain('ILIKE $');
      expect(values).toContain(SUPER_ADMIN_USER.id);
    });

    it('rejects date range query window exceeding 90 days with 400', async () => {
      const res = await request(app)
        .get('/api/v1/admin/audit')
        .query({
          startDate: '2026-01-01T00:00:00.000Z',
          endDate: '2026-06-01T00:00:00.000Z',
        })
        .set('Authorization', `Bearer ${SESSIONS.auditRead}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('90 days');
    });

    it('rejects date range where start date is after end date with 400', async () => {
      const res = await request(app)
        .get('/api/v1/admin/audit')
        .query({
          startDate: '2026-09-20T00:00:00.000Z',
          endDate: '2026-09-10T00:00:00.000Z',
        })
        .set('Authorization', `Bearer ${SESSIONS.auditRead}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  // ── 3. Audit Detail & Redaction Endpoints ───────────────────────────────────

  describe('3. GET /api/v1/admin/audit/:id and Redaction', () => {
    it('returns single audit record with strict recursive redaction of sensitive credentials', async () => {
      adminActionRepository.query.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_AUDIT_ID,
            actor_id: SUPER_ADMIN_USER.id,
            actor_role: 'ADMIN',
            permission: 'SUPER_ADMIN',
            action: 'UPDATE_COMMISSION_RULE',
            target_resource: 'PAYMENT_RULE',
            target_resource_id: 'rule-1',
            request_id: 'req-secret-1',
            ip_address: '10.10.10.10',
            user_agent: 'SecAgent',
            before_state: {
              passwordHash: 'argon2_secret_hash',
              apiKey: 'live_secret_key_123',
              normalField: 'ok',
            },
            after_state: {
              passwordHash: 'new_argon2_secret_hash',
              token: 'sup_bearer_token',
              normalField: 'updated',
            },
            metadata: {
              sessionToken: 'raw_session_credential',
              fcmToken: 'device_fcm_token_xyz',
              nested: {
                secret: 'nested_provider_secret',
                cookie: 'session_cookie=abc',
                safeText: 'hello',
              },
            },
            created_at: new Date('2026-09-02T15:00:00Z'),
            actor_name: 'Super Admin',
            actor_email: 'superadmin@gongo.in',
          },
        ],
      });

      const res = await request(app)
        .get(`/api/v1/admin/audit/${TEST_AUDIT_ID}`)
        .set('Authorization', `Bearer ${SESSIONS.auditRead}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const record = res.body.data;
      expect(record.id).toBe(TEST_AUDIT_ID);
      // Redaction verification: ALL sensitive keys must be replaced with [REDACTED]
      expect(record.beforeState.passwordHash).toBe('[REDACTED]');
      expect(record.beforeState.apiKey).toBe('[REDACTED]');
      expect(record.beforeState.normalField).toBe('ok');

      expect(record.afterState.passwordHash).toBe('[REDACTED]');
      expect(record.afterState.token).toBe('[REDACTED]');
      expect(record.afterState.normalField).toBe('updated');

      expect(record.metadata.sessionToken).toBe('[REDACTED]');
      expect(record.metadata.fcmToken).toBe('[REDACTED]');
      expect(record.metadata.nested.secret).toBe('[REDACTED]');
      expect(record.metadata.nested.cookie).toBe('[REDACTED]');
      expect(record.metadata.nested.safeText).toBe('hello');
    });

    it('returns 400 for malformed audit ID UUID', async () => {
      const res = await request(app)
        .get('/api/v1/admin/audit/not-a-valid-uuid')
        .set('Authorization', `Bearer ${SESSIONS.auditRead}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('RFC 4122 UUID');
    });

    it('returns 404 when audit record does not exist', async () => {
      adminActionRepository.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get('/api/v1/admin/audit/da000001-9999-4000-a000-000000000000')
        .set('Authorization', `Bearer ${SESSIONS.auditRead}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  // ── 4. Distinct Actions Catalog ─────────────────────────────────────────────

  describe('4. GET /api/v1/admin/audit/actions', () => {
    it('returns distinct action names, target resources, and security categories', async () => {
      adminActionRepository.query
        .mockResolvedValueOnce({
          rows: [{ action: 'ADMIN_LOGIN' }, { action: 'CANCEL_BOOKING' }],
        })
        .mockResolvedValueOnce({
          rows: [{ target_resource: 'ADMIN_SESSION' }, { target_resource: 'BOOKING' }],
        });

      const res = await request(app)
        .get('/api/v1/admin/audit/actions')
        .set('Authorization', `Bearer ${SESSIONS.auditRead}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.actions).toEqual(['ADMIN_LOGIN', 'CANCEL_BOOKING']);
      expect(res.body.data.resources).toEqual(['ADMIN_SESSION', 'BOOKING']);
      expect(res.body.data.categories).toContain('AUTHENTICATION');
      expect(res.body.data.categories).toContain('FINANCIAL');
    });
  });

  // ── 5. Security Events & Categorization ─────────────────────────────────────

  describe('5. GET /api/v1/admin/audit/security and /api/v1/admin/security/events', () => {
    it('returns security events via /api/v1/admin/audit/security with category filtering', async () => {
      adminActionRepository.query
        .mockResolvedValueOnce({ rows: [{ total: '1' }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: TEST_AUDIT_ID,
              actor_id: SUPER_ADMIN_USER.id,
              action: 'ADMIN_LOGIN',
              target_resource: 'ADMIN_SESSION',
              created_at: new Date('2026-09-01T12:00:00Z'),
            },
          ],
        });

      const res = await request(app)
        .get('/api/v1/admin/audit/security?category=AUTHENTICATION')
        .set('Authorization', `Bearer ${SESSIONS.securityRead}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
    });

    it('returns security events via /api/v1/admin/security/events', async () => {
      adminActionRepository.query
        .mockResolvedValueOnce({ rows: [{ total: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get('/api/v1/admin/security/events')
        .set('Authorization', `Bearer ${SESSIONS.securityRead}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 400 for invalid security category', async () => {
      const res = await request(app)
        .get('/api/v1/admin/security/events?category=UNKNOWN_SECURITY_CAT')
        .set('Authorization', `Bearer ${SESSIONS.securityRead}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('Invalid security category');
    });
  });

  // ── 6. Admin Actor Audit Trail ──────────────────────────────────────────────

  describe('6. GET /api/v1/admin/audit/admin/:adminId', () => {
    it('returns audit records performed by a specific admin actor', async () => {
      adminActionRepository.query
        .mockResolvedValueOnce({ rows: [{ total: '1' }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: TEST_AUDIT_ID,
              actor_id: AUDIT_READ_ADMIN.id,
              action: 'ADMIN_LOGIN',
              target_resource: 'ADMIN_SESSION',
              created_at: new Date('2026-09-01T12:00:00Z'),
            },
          ],
        });

      const res = await request(app)
        .get(`/api/v1/admin/audit/admin/${AUDIT_READ_ADMIN.id}`)
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
    });

    it('returns 400 for malformed adminId UUID', async () => {
      const res = await request(app)
        .get('/api/v1/admin/audit/admin/invalid-admin-id')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('returns 404 when target admin user does not exist', async () => {
      const res = await request(app)
        .get('/api/v1/admin/audit/admin/a0000001-9999-4000-a000-000000000000')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('returns 400 when target user exists but is not an ADMIN role', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/audit/admin/${NON_ADMIN_CUSTOMER.id}`)
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('not an administrator');
    });
  });

  // ── 7. Resource Audit Trail ─────────────────────────────────────────────────

  describe('7. GET /api/v1/admin/audit/resource/:resourceType/:resourceId', () => {
    it('returns chronological audit history for a specific entity (e.g. BOOKING)', async () => {
      adminActionRepository.query
        .mockResolvedValueOnce({ rows: [{ total: '1' }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: TEST_AUDIT_ID,
              actor_id: SUPER_ADMIN_USER.id,
              action: 'CANCEL_BOOKING',
              target_resource: 'BOOKING',
              target_resource_id: TEST_BOOKING_ID,
              created_at: new Date('2026-09-01T14:00:00Z'),
            },
          ],
        });

      const res = await request(app)
        .get(`/api/v1/admin/audit/resource/BOOKING/${TEST_BOOKING_ID}`)
        .set('Authorization', `Bearer ${SESSIONS.auditRead}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].targetResource).toBe('BOOKING');
    });
  });

  // ── 8. Security Summary Aggregation ─────────────────────────────────────────

  describe('8. GET /api/v1/admin/security/summary', () => {
    it('returns operational security summary metrics within bounded time window', async () => {
      adminActionRepository.query
        .mockResolvedValueOnce({ rows: [{ total: '15' }] })
        .mockResolvedValueOnce({ rows: [{ action: 'ADMIN_LOGIN', count: '10' }] })
        .mockResolvedValueOnce({ rows: [{ target_resource: 'ADMIN_SESSION', count: '10' }] })
        .mockResolvedValueOnce({
          rows: [
            {
              actor_id: SUPER_ADMIN_USER.id,
              actor_name: 'Super Admin',
              actor_email: 'superadmin@gongo.in',
              action_count: '10',
            },
          ],
        });

      const res = await request(app)
        .get('/api/v1/admin/security/summary')
        .query({
          startDate: '2026-09-01T00:00:00.000Z',
          endDate: '2026-09-02T00:00:00.000Z',
        })
        .set('Authorization', `Bearer ${SESSIONS.securityRead}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.totalEvents).toBe(15);
      expect(res.body.data.actionBreakdown).toHaveLength(1);
      expect(res.body.data.topActors).toHaveLength(1);
      expect(res.body.data.timeWindow).toBeDefined();
    });

    it('rejects query window exceeding 90 days with 400', async () => {
      const res = await request(app)
        .get('/api/v1/admin/security/summary')
        .query({
          startDate: '2026-01-01T00:00:00.000Z',
          endDate: '2026-06-01T00:00:00.000Z',
        })
        .set('Authorization', `Bearer ${SESSIONS.securityRead}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  // ── 9. Immutability & Modification Denial ───────────────────────────────────

  describe('9. Immutability & Modification Denial', () => {
    it('denies POST to /api/v1/admin/audit (append-only via internal operations)', async () => {
      const res = await request(app)
        .post('/api/v1/admin/audit')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`)
        .send({ action: 'FORGED_AUDIT' });

      // Should be 404 (Route not defined) or 405
      expect([404, 405]).toContain(res.status);
    });

    it('denies PUT to /api/v1/admin/audit/:id (historical records cannot be edited)', async () => {
      const res = await request(app)
        .put(`/api/v1/admin/audit/${TEST_AUDIT_ID}`)
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`)
        .send({ action: 'MODIFIED_ACTION' });

      expect([404, 405]).toContain(res.status);
    });

    it('denies PATCH to /api/v1/admin/audit/:id (historical records cannot be patched)', async () => {
      const res = await request(app)
        .patch(`/api/v1/admin/audit/${TEST_AUDIT_ID}`)
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`)
        .send({ action: 'PATCHED_ACTION' });

      expect([404, 405]).toContain(res.status);
    });

    it('denies DELETE to /api/v1/admin/audit/:id (historical records cannot be deleted)', async () => {
      const res = await request(app)
        .delete(`/api/v1/admin/audit/${TEST_AUDIT_ID}`)
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);

      expect([404, 405]).toContain(res.status);
    });
  });
});
