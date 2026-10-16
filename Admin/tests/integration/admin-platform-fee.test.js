'use strict';

const request = require('supertest');

// Mock logger to suppress console noise during testing
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
const platformFeeRepository = require('../../src/repositories/platform-fee.repository');
const adminActionRepository = require('../../src/repositories/admin-action.repository');
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
  is_active: true,
  permissions: [PERMISSIONS.SUPER_ADMIN],
};

const FINANCE_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000002',
  auth_id: 'sup-finance-admin',
  role: 'ADMIN',
  name: 'Finance Admin',
  email: 'financeadmin@gongo.in',
  is_active: true,
  permissions: [
    PERMISSIONS.PLATFORM_FEE_READ,
    PERMISSIONS.PLATFORM_FEE_UPDATE,
    PERMISSIONS.COMMISSIONS_READ,
    PERMISSIONS.COMMISSIONS_UPDATE,
  ],
};

const READONLY_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000003',
  auth_id: 'sup-readonly-admin',
  role: 'ADMIN',
  name: 'Readonly Admin',
  email: 'readonly@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.PLATFORM_FEE_READ],
};

const NO_PERM_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000004',
  auth_id: 'sup-noperm-admin',
  role: 'ADMIN',
  name: 'No Perm Admin',
  email: 'nopermadmin@gongo.in',
  is_active: true,
  permissions: [],
};

const CUSTOMER_USER = {
  id: 'c0000001-0000-4000-c000-000000000001',
  auth_id: 'sup-customer',
  role: 'CUSTOMER',
  name: 'Regular Customer',
  email: 'customer@gongo.in',
  is_active: true,
  permissions: [],
};

const SESSIONS = {
  superAdmin: 'sess_superadmin_pfee_token_001',
  financeAdmin: 'sess_financeadmin_pfee_token_002',
  readonlyAdmin: 'sess_readonlyadmin_pfee_token_003',
  noPermAdmin: 'sess_nopermadmin_pfee_token_004',
  customer: 'sess_customer_pfee_token_005',
};

describe('Integration: Admin Platform Fee APIs', () => {
  let activeDbConfig;
  let auditLogs;

  beforeEach(() => {
    jest.clearAllMocks();
    auditLogs = [];

    activeDbConfig = {
      serviceCharge: {
        id: '8e130156-9b3b-4f4d-b50b-f8a3c04ea675',
        calculationType: 'fixed',
        value: 2.50,
        currency: 'INR',
        isActive: true,
        createdBy: SUPER_ADMIN_USER.id,
        createdAt: new Date('2026-10-09T05:38:47.480Z').toISOString(),
        updatedAt: new Date('2026-10-09T05:38:47.480Z').toISOString(),
      },
      convenienceFee: {
        id: 'b1699dea-b202-4402-a318-a969f9199561',
        calculationType: 'fixed',
        value: 2.00,
        currency: 'INR',
        isActive: true,
        createdBy: SUPER_ADMIN_USER.id,
        createdAt: new Date('2026-10-09T05:38:47.480Z').toISOString(),
        updatedAt: new Date('2026-10-09T05:38:47.480Z').toISOString(),
      },
      gst: {
        id: 'f68a0d50-a3fd-463b-8d5f-54e6b1db126f',
        calculationType: 'percentage',
        value: 18.00,
        currency: 'INR',
        isActive: true,
        createdBy: SUPER_ADMIN_USER.id,
        createdAt: new Date('2026-10-09T05:38:47.480Z').toISOString(),
        updatedAt: new Date('2026-10-09T05:38:47.480Z').toISOString(),
      },
    };

    // Session resolution mock
    jest.spyOn(adminSessionRepository, 'findByToken').mockImplementation(async (hash) => {
      const match = (token) => hash === hashSessionToken(token);
      let user = null;

      if (match(SESSIONS.superAdmin)) user = SUPER_ADMIN_USER;
      else if (match(SESSIONS.financeAdmin)) user = FINANCE_ADMIN;
      else if (match(SESSIONS.readonlyAdmin)) user = READONLY_ADMIN;
      else if (match(SESSIONS.noPermAdmin)) user = NO_PERM_ADMIN;
      else if (match(SESSIONS.customer)) user = CUSTOMER_USER;

      if (!user) return null;

      return {
        id: 'sess-active',
        user_id: user.id,
        session_token: hash,
        is_active: true,
        created_at: new Date(),
        last_active_at: new Date(),
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      };
    });

    // User lookup mock
    jest.spyOn(userRepository, 'findById').mockImplementation(async (id) => {
      const allUsers = [
        SUPER_ADMIN_USER,
        FINANCE_ADMIN,
        READONLY_ADMIN,
        NO_PERM_ADMIN,
        CUSTOMER_USER,
      ];
      return allUsers.find((u) => u.id === id) || null;
    });

    // Permission lookup mock
    jest.spyOn(adminPermissionRepository, 'findPermissionsByUserId').mockImplementation(async (id) => {
      const allUsers = [
        SUPER_ADMIN_USER,
        FINANCE_ADMIN,
        READONLY_ADMIN,
        NO_PERM_ADMIN,
        CUSTOMER_USER,
      ];
      const found = allUsers.find((u) => u.id === id);
      return found ? found.permissions : [];
    });

    // Repository mocks
    jest.spyOn(platformFeeRepository, 'findActive').mockImplementation(async () => activeDbConfig);

    jest.spyOn(platformFeeRepository, 'updateActiveCharges').mockImplementation(
      async ({ serviceCharge, convenienceFee, gst, adminId = null }) => {
        const previous = activeDbConfig ? { ...activeDbConfig } : null;
        const now = new Date().toISOString();

        activeDbConfig = {
          serviceCharge: {
            ...activeDbConfig.serviceCharge,
            value: serviceCharge,
            createdBy: adminId,
            updatedAt: now,
          },
          convenienceFee: {
            ...activeDbConfig.convenienceFee,
            value: convenienceFee,
            createdBy: adminId,
            updatedAt: now,
          },
          gst: {
            ...activeDbConfig.gst,
            value: gst,
            createdBy: adminId,
            updatedAt: now,
          },
        };

        return {
          previous,
          current: activeDbConfig,
        };
      },
    );

    // Audit logs mock
    jest.spyOn(adminActionRepository, 'createAction').mockImplementation(async (action) => {
      auditLogs.push(action);
      return { id: 'act-uuid-1' };
    });

    jest.spyOn(auditService, 'logAdminAction').mockImplementation(async (event) => {
      auditLogs.push(event);
      return { id: 'act-uuid-1' };
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 1. ADMIN GET /api/v1/admin/platform-fee
  // ════════════════════════════════════════════════════════════════════════════

  describe('GET /api/v1/admin/platform-fee', () => {
    it('1. Authorized super admin can get active platform fee configuration', async () => {
      const res = await request(app)
        .get('/api/v1/admin/platform-fee')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({
        serviceCharge: {
          calculationType: 'fixed',
          value: 2.50,
          currency: 'INR',
        },
        convenienceFee: {
          calculationType: 'fixed',
          value: 2.00,
          currency: 'INR',
        },
        gst: {
          calculationType: 'percentage',
          value: 18.00,
        },
      });
    });

    it('1b. Authorized finance admin can get active platform fee', async () => {
      const res = await request(app)
        .get('/api/v1/admin/platform-fee')
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.serviceCharge.value).toBe(2.50);
    });

    it('1c. Also accessible on direct /admin/platform-fee route alias', async () => {
      const res = await request(app)
        .get('/admin/platform-fee')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.convenienceFee.value).toBe(2.00);
    });

    it('1d. Also accessible on /api/v1/admin/platform-charge alias', async () => {
      const res = await request(app)
        .get('/api/v1/admin/platform-charge')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.gst.value).toBe(18.00);
    });

    it('2. Unauthorized user gets 401 when unauthenticated', async () => {
      const res = await request(app).get('/api/v1/admin/platform-fee');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('2b. Non-admin user (customer) gets 403 Forbidden', async () => {
      const res = await request(app)
        .get('/api/v1/admin/platform-fee')
        .set('Authorization', `Bearer ${SESSIONS.customer}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('2c. Admin without required permissions gets 403 Forbidden', async () => {
      const res = await request(app)
        .get('/api/v1/admin/platform-fee')
        .set('Authorization', `Bearer ${SESSIONS.noPermAdmin}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 2. ADMIN PUT /api/v1/admin/platform-fee
  // ════════════════════════════════════════════════════════════════════════════

  describe('PUT /api/v1/admin/platform-fee', () => {
    it('4. Admin can update platform fees (service charge, convenience fee, GST)', async () => {
      const res = await request(app)
        .put('/api/v1/admin/platform-fee')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`)
        .send({
          serviceCharge: 3.50,
          convenienceFee: 2.50,
          gst: 18,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({
        serviceCharge: {
          calculationType: 'fixed',
          value: 3.50,
        },
        convenienceFee: {
          calculationType: 'fixed',
          value: 2.50,
        },
        gst: {
          calculationType: 'percentage',
          value: 18,
        },
      });
    });

    it('5. PATCH /api/v1/admin/platform-fee also works', async () => {
      const res = await request(app)
        .patch('/api/v1/admin/platform-fee')
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`)
        .send({
          serviceCharge: 2.50,
          convenienceFee: 2.00,
          gst: 18,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.serviceCharge.value).toBe(2.50);
    });

    it('6. Negative serviceCharge rejected with 400 Bad Request', async () => {
      const res = await request(app)
        .put('/api/v1/admin/platform-fee')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`)
        .send({
          serviceCharge: -1,
          convenienceFee: 2.00,
          gst: 18,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toMatch(/negative/i);
    });

    it('7. Negative convenienceFee rejected with 400 Bad Request', async () => {
      const res = await request(app)
        .put('/api/v1/admin/platform-fee')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`)
        .send({
          serviceCharge: 2.50,
          convenienceFee: -10,
          gst: 18,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toMatch(/negative/i);
    });

    it('8. GST > 100 rejected with 400 Bad Request', async () => {
      const res = await request(app)
        .put('/api/v1/admin/platform-fee')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`)
        .send({
          serviceCharge: 2.50,
          convenienceFee: 2.00,
          gst: 150,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toMatch(/cannot exceed 100/i);
    });

    it('8b. Negative GST rejected with 400 Bad Request', async () => {
      const res = await request(app)
        .put('/api/v1/admin/platform-fee')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`)
        .send({
          serviceCharge: 2.50,
          convenienceFee: 2.00,
          gst: -5,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toMatch(/negative/i);
    });

    it('9. updated_at changes on update', async () => {
      const oldUpdatedAt = activeDbConfig.serviceCharge.updatedAt;

      const res = await request(app)
        .put('/api/v1/admin/platform-fee')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`)
        .send({
          serviceCharge: 2.75,
          convenienceFee: 2.00,
          gst: 18,
        });

      expect(res.status).toBe(200);
      expect(res.body.data.serviceCharge.updatedAt).toBeDefined();
      expect(res.body.data.serviceCharge.updatedAt).not.toBe(oldUpdatedAt);
    });

    it('10. Admin identity is stored according to audit conventions', async () => {
      const res = await request(app)
        .put('/api/v1/admin/platform-fee')
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`)
        .send({
          serviceCharge: 2.50,
          convenienceFee: 2.00,
          gst: 18,
        });

      expect(res.status).toBe(200);
      expect(activeDbConfig.serviceCharge.createdBy).toBe(FINANCE_ADMIN.id);

      // Verify audit event was emitted
      expect(auditLogs.length).toBeGreaterThan(0);
      const auditEvent = auditLogs.find((l) => l.action === 'PLATFORM_FEE_UPDATE');
      expect(auditEvent).toBeDefined();
      expect(auditEvent.actorId).toBe(FINANCE_ADMIN.id);
    });

    it('11. Readonly admin cannot update fee (403 Forbidden)', async () => {
      const res = await request(app)
        .put('/api/v1/admin/platform-fee')
        .set('Authorization', `Bearer ${SESSIONS.readonlyAdmin}`)
        .send({
          serviceCharge: 2.50,
          convenienceFee: 2.00,
          gst: 18,
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });
  });
});
