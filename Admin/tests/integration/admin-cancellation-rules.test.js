'use strict';

const request = require('supertest');

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
const cancellationRulesRepo = require('../../src/repositories/cancellation-rules.repository');
const { hashSessionToken } = require('../../src/utils/crypto');
const { PERMISSIONS } = require('../../src/constants/permissions');
const { createApp } = require('../../src/app');

const app = createApp();

const SUPER_ADMIN_USER = {
  id: 'a0000001-0000-4000-a000-000000000001',
  auth_id: 'sup-super-admin',
  role: 'ADMIN',
  name: 'Super Admin',
  email: 'superadmin@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.SUPER_ADMIN],
};

const SETTINGS_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000002',
  auth_id: 'sup-settings-admin',
  role: 'ADMIN',
  name: 'Settings Admin',
  email: 'settingsadmin@gongo.in',
  is_active: true,
  permissions: [
    PERMISSIONS.SETTINGS_READ,
    PERMISSIONS.SETTINGS_UPDATE,
  ],
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
  superAdmin: 'sess_superadmin_crules_001',
  settingsAdmin: 'sess_settingsadmin_crules_002',
  noPermAdmin: 'sess_nopermadmin_crules_004',
  customer: 'sess_customer_crules_005',
};

describe('Integration: Admin Cancellation Rules APIs', () => {
  let dbStore;

  beforeEach(() => {
    jest.clearAllMocks();

    dbStore = {
      bike: [
        { id: 'b-1', tier: 1, notice_hours: 6, refund_percentage: 0, is_active: true },
        { id: 'b-2', tier: 2, notice_hours: 12, refund_percentage: 50, is_active: true },
        { id: 'b-3', tier: 3, notice_hours: 24, refund_percentage: 100, is_active: true },
      ],
      car: [
        { id: 'c-1', tier: 1, notice_hours: 12, refund_percentage: 0, is_active: true },
        { id: 'c-2', tier: 2, notice_hours: 24, refund_percentage: 50, is_active: true },
        { id: 'c-3', tier: 3, notice_hours: 24, refund_percentage: 100, is_active: true },
      ],
    };

    // Session mock
    jest.spyOn(adminSessionRepository, 'findByToken').mockImplementation(async (hash) => {
      const match = (token) => hash === hashSessionToken(token);
      let user = null;

      if (match(SESSIONS.superAdmin)) user = SUPER_ADMIN_USER;
      else if (match(SESSIONS.settingsAdmin)) user = SETTINGS_ADMIN;
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

    jest.spyOn(userRepository, 'findById').mockImplementation(async (id) => {
      if (id === SUPER_ADMIN_USER.id) return SUPER_ADMIN_USER;
      if (id === SETTINGS_ADMIN.id) return SETTINGS_ADMIN;
      if (id === NO_PERM_ADMIN.id) return NO_PERM_ADMIN;
      if (id === CUSTOMER_USER.id) return CUSTOMER_USER;
      return null;
    });

    jest.spyOn(adminPermissionRepository, 'findPermissionsByUserId').mockImplementation(async (id) => {
      if (id === SUPER_ADMIN_USER.id) return [PERMISSIONS.SUPER_ADMIN];
      if (id === SETTINGS_ADMIN.id) {
        return [PERMISSIONS.SETTINGS_READ, PERMISSIONS.SETTINGS_UPDATE];
      }
      return [];
    });

    // Mock repository resolver
    cancellationRulesRepo.setMockCancellationRulesResolver({
      findByVehicleType: async (type) => (
        (dbStore[type] || []).map((r) => ({
          id: r.id,
          tier: Number(r.tier),
          noticeHours: Number(r.notice_hours),
          refundPercentage: Number(r.refund_percentage),
        }))
      ),
      findAll: async () => ({
        bike: dbStore.bike.map((r) => ({
          id: r.id,
          tier: Number(r.tier),
          noticeHours: Number(r.notice_hours),
          refundPercentage: Number(r.refund_percentage),
        })),
        car: dbStore.car.map((r) => ({
          id: r.id,
          tier: Number(r.tier),
          noticeHours: Number(r.notice_hours),
          refundPercentage: Number(r.refund_percentage),
        })),
      }),
      updateRulesForVehicleType: async ({ vehicleType, rules }) => {
        dbStore[vehicleType] = rules.map((r, i) => ({
          id: `new-${vehicleType}-${i + 1}`,
          tier: i + 1,
          notice_hours: Number(r.noticeHours ?? r.notice_hours),
          refund_percentage: Number(r.refundPercentage ?? r.refund_percentage),
          is_active: true,
        }));
        return dbStore[vehicleType].map((r) => ({
          id: r.id,
          tier: Number(r.tier),
          noticeHours: Number(r.notice_hours),
          refundPercentage: Number(r.refund_percentage),
        }));
      },
      updateAllRules: async ({ bike, car }) => {
        dbStore.bike = bike.map((r, i) => ({
          id: `new-bike-${i + 1}`,
          tier: i + 1,
          notice_hours: Number(r.noticeHours ?? r.notice_hours),
          refund_percentage: Number(r.refundPercentage ?? r.refund_percentage),
          is_active: true,
        }));
        dbStore.car = car.map((r, i) => ({
          id: `new-car-${i + 1}`,
          tier: i + 1,
          notice_hours: Number(r.noticeHours ?? r.notice_hours),
          refund_percentage: Number(r.refundPercentage ?? r.refund_percentage),
          is_active: true,
        }));
        return {
          bike: dbStore.bike.map((r) => ({
            id: r.id,
            tier: Number(r.tier),
            noticeHours: Number(r.notice_hours),
            refundPercentage: Number(r.refund_percentage),
          })),
          car: dbStore.car.map((r) => ({
            id: r.id,
            tier: Number(r.tier),
            noticeHours: Number(r.notice_hours),
            refundPercentage: Number(r.refund_percentage),
          })),
        };
      },
    });
  });

  afterAll(() => {
    cancellationRulesRepo.resetMockCancellationRulesResolver();
  });

  describe('GET /api/v1/admin/cancellation-rules', () => {
    it('returns 401 when no auth token provided', async () => {
      const res = await request(app).get('/api/v1/admin/cancellation-rules');
      expect(res.status).toBe(401);
    });

    it('returns 403 when customer role attempts access', async () => {
      const res = await request(app)
        .get('/api/v1/admin/cancellation-rules')
        .set('Authorization', `Bearer ${SESSIONS.customer}`);
      expect(res.status).toBe(403);
    });

    it('returns 403 when admin has no settings permission', async () => {
      const res = await request(app)
        .get('/api/v1/admin/cancellation-rules')
        .set('Authorization', `Bearer ${SESSIONS.noPermAdmin}`);
      expect(res.status).toBe(403);
    });

    it('returns active rules for super admin', async () => {
      const res = await request(app)
        .get('/api/v1/admin/cancellation-rules')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.bike).toHaveLength(3);
      expect(res.body.data.car).toHaveLength(3);
      expect(res.body.data.bike[0]).toEqual({
        id: 'b-1',
        tier: 1,
        noticeHours: 6,
        refundPercentage: 0,
      });
    });

    it('returns vehicle-specific rules when vehicleType query param is given', async () => {
      const res = await request(app)
        .get('/api/v1/admin/cancellation-rules?vehicleType=bike')
        .set('Authorization', `Bearer ${SESSIONS.settingsAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.vehicleType).toBe('bike');
      expect(res.body.data.rules).toHaveLength(3);
    });
  });

  describe('PUT /api/v1/admin/cancellation-rules', () => {
    it('updates Bike rules only and leaves Car unchanged', async () => {
      const res = await request(app)
        .put('/api/v1/admin/cancellation-rules')
        .set('Authorization', `Bearer ${SESSIONS.settingsAdmin}`)
        .send({
          vehicleType: 'bike',
          rules: [
            { tier: 1, noticeHours: 8, refundPercentage: 0 },
            { tier: 2, noticeHours: 24, refundPercentage: 100 },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(dbStore.bike).toHaveLength(2);
      expect(dbStore.bike[0].notice_hours).toBe(8);
      // Car rules remain untouched at 3
      expect(dbStore.car).toHaveLength(3);
    });

    it('updates Car rules only and leaves Bike unchanged', async () => {
      const res = await request(app)
        .put('/api/v1/admin/cancellation-rules')
        .set('Authorization', `Bearer ${SESSIONS.settingsAdmin}`)
        .send({
          vehicleType: 'car',
          rules: [
            { tier: 1, noticeHours: 12, refundPercentage: 0 },
            { tier: 2, noticeHours: 24, refundPercentage: 50 },
            { tier: 3, noticeHours: 48, refundPercentage: 100 },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(dbStore.car).toHaveLength(3);
      expect(dbStore.car[2].notice_hours).toBe(48);
      expect(dbStore.bike).toHaveLength(3);
    });

    it('updates both in All Vehicles mode', async () => {
      const res = await request(app)
        .put('/api/v1/admin/cancellation-rules')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`)
        .send({
          vehicleType: 'all',
          bike: [
            { tier: 1, noticeHours: 6, refundPercentage: 0 },
            { tier: 2, noticeHours: 12, refundPercentage: 100 },
          ],
          car: [
            { tier: 1, noticeHours: 12, refundPercentage: 0 },
            { tier: 2, noticeHours: 24, refundPercentage: 100 },
          ],
        });

      expect(res.status).toBe(200);
      expect(dbStore.bike).toHaveLength(2);
      expect(dbStore.car).toHaveLength(2);
    });

    it('rejects invalid vehicle type with 400', async () => {
      const res = await request(app)
        .put('/api/v1/admin/cancellation-rules')
        .set('Authorization', `Bearer ${SESSIONS.settingsAdmin}`)
        .send({
          vehicleType: 'scooter',
          rules: [{ tier: 1, noticeHours: 6, refundPercentage: 0 }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_VEHICLE_TYPE');
    });

    it('rejects descending notice hours with 400', async () => {
      const res = await request(app)
        .put('/api/v1/admin/cancellation-rules')
        .set('Authorization', `Bearer ${SESSIONS.settingsAdmin}`)
        .send({
          vehicleType: 'bike',
          rules: [
            { tier: 1, noticeHours: 24, refundPercentage: 0 },
            { tier: 2, noticeHours: 6, refundPercentage: 50 },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_NOTICE_HOURS_ORDER');
    });
  });
});
