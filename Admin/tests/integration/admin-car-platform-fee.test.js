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
const platformFeeRepository = require('../../src/repositories/platform-fee.repository');
const adminActionRepository = require('../../src/repositories/admin-action.repository');
const auditService = require('../../src/services/audit.service');
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
  superAdmin: 'sess_superadmin_car_fee_001',
  financeAdmin: 'sess_financeadmin_car_fee_002',
  readonlyAdmin: 'sess_readonlyadmin_car_fee_003',
  customer: 'sess_customer_car_fee_004',
};

describe('Integration: Admin Car Platform Fee APIs', () => {
  let inMemoryDb;
  let auditLogs;

  beforeEach(() => {
    jest.clearAllMocks();
    auditLogs = [];

    inMemoryDb = {
      bike: {
        serviceCharge: {
          id: 'b-sc-1',
          calculationType: 'fixed',
          value: 2.40,
          currency: 'INR',
          isActive: true,
        },
        convenienceFee: {
          id: 'b-cf-1',
          calculationType: 'fixed',
          value: 1.84,
          currency: 'INR',
          isActive: true,
        },
        gst: {
          id: 'b-gst-1',
          calculationType: 'percentage',
          value: 18.00,
          currency: 'INR',
          isActive: true,
        },
      },
      car: {
        serviceCharge: {
          id: 'c-sc-1',
          calculationType: 'fixed',
          value: 5.00,
          currency: 'INR',
          isActive: true,
        },
        convenienceFee: {
          id: 'c-cf-1',
          calculationType: 'fixed',
          value: 3.00,
          currency: 'INR',
          isActive: true,
        },
        gst: {
          id: 'c-gst-1',
          calculationType: 'percentage',
          value: 18.00,
          currency: 'INR',
          isActive: true,
        },
      },
    };

    jest.spyOn(adminSessionRepository, 'findByToken').mockImplementation(async (hash) => {
      const match = (token) => hash === hashSessionToken(token);
      let user = null;
      if (match(SESSIONS.superAdmin)) user = SUPER_ADMIN_USER;
      else if (match(SESSIONS.financeAdmin)) user = FINANCE_ADMIN;
      else if (match(SESSIONS.readonlyAdmin)) user = READONLY_ADMIN;
      else if (match(SESSIONS.customer)) user = CUSTOMER_USER;

      if (!user) return null;
      return {
        id: 'sess-active',
        user_id: user.id,
        session_token: hash,
        is_active: true,
      };
    });

    jest.spyOn(userRepository, 'findById').mockImplementation(async (id) => {
      const allUsers = [SUPER_ADMIN_USER, FINANCE_ADMIN, READONLY_ADMIN, CUSTOMER_USER];
      return allUsers.find((u) => u.id === id) || null;
    });

    jest.spyOn(adminPermissionRepository, 'findPermissionsByUserId').mockImplementation(async (id) => {
      const allUsers = [SUPER_ADMIN_USER, FINANCE_ADMIN, READONLY_ADMIN, CUSTOMER_USER];
      const found = allUsers.find((u) => u.id === id);
      return found ? found.permissions : [];
    });

    jest.spyOn(platformFeeRepository, 'findActive').mockImplementation(async (vehicleType) => {
      if (vehicleType === 'car') return inMemoryDb.car;
      if (vehicleType === 'bike') return inMemoryDb.bike;
      return {
        ...inMemoryDb.bike,
        bike: inMemoryDb.bike,
        car: inMemoryDb.car,
      };
    });

    jest.spyOn(platformFeeRepository, 'updateActiveCharges').mockImplementation(
      async ({ serviceCharge, convenienceFee, gst, adminId = null, vehicleType = 'bike' }) => {
        const isCar = vehicleType === 'car';
        const target = isCar ? inMemoryDb.car : inMemoryDb.bike;
        const previous = JSON.parse(JSON.stringify(target));
        const now = new Date().toISOString();

        target.serviceCharge.value = serviceCharge;
        target.serviceCharge.updatedAt = now;
        target.serviceCharge.createdBy = adminId;

        target.convenienceFee.value = convenienceFee;
        target.convenienceFee.updatedAt = now;
        target.convenienceFee.createdBy = adminId;

        target.gst.value = gst;
        target.gst.updatedAt = now;
        target.gst.createdBy = adminId;

        return {
          previous,
          current: JSON.parse(JSON.stringify(target)),
          vehicleType: isCar ? 'car' : 'bike',
        };
      },
    );

    jest.spyOn(adminActionRepository, 'createAction').mockImplementation(async (action) => {
      auditLogs.push(action);
      return { id: 'act-uuid-1' };
    });

    jest.spyOn(auditService, 'logAdminAction').mockImplementation(async (event) => {
      auditLogs.push(event);
      return { id: 'act-uuid-1' };
    });
  });

  describe('GET Car Platform Fees', () => {
    it('1. GET /api/v1/admin/platform-fee/car returns car fee configuration with 9.44 total', async () => {
      const res = await request(app)
        .get('/api/v1/admin/platform-fee/car')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.serviceCharge.value).toBe(5.00);
      expect(res.body.data.convenienceFee.value).toBe(3.00);
      expect(res.body.data.gst.value).toBe(18.00);
      expect(res.body.data.totalPlatformFees).toBe(9.44);
    });

    it('2. GET /api/v1/admin/platform-fee?vehicleType=car returns car fee configuration', async () => {
      const res = await request(app)
        .get('/api/v1/admin/platform-fee?vehicleType=car')
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.serviceCharge.value).toBe(5.00);
      expect(res.body.data.convenienceFee.value).toBe(3.00);
      expect(res.body.data.gst.value).toBe(18.00);
      expect(res.body.data.totalPlatformFees).toBe(9.44);
    });

    it('3. GET /api/v1/admin/platform-fee without query returns bike at root and includes both bike and car', async () => {
      const res = await request(app)
        .get('/api/v1/admin/platform-fee')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.serviceCharge.value).toBe(2.40);
      expect(res.body.data.convenienceFee.value).toBe(1.84);
      expect(res.body.data.gst.value).toBe(18.00);
      expect(res.body.data.car.serviceCharge.value).toBe(5.00);
      expect(res.body.data.car.convenienceFee.value).toBe(3.00);
      expect(res.body.data.car.gst.value).toBe(18.00);
    });
  });

  describe('PUT Car Platform Fees', () => {
    it('4. Admin can update car platform fees via PUT /api/v1/admin/platform-fee/car', async () => {
      const res = await request(app)
        .put('/api/v1/admin/platform-fee/car')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`)
        .send({
          serviceCharge: 6.00,
          convenienceFee: 4.00,
          gst: 18.00,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.serviceCharge.value).toBe(6.00);
      expect(res.body.data.convenienceFee.value).toBe(4.00);
      expect(res.body.data.gst.value).toBe(18.00);
      expect(res.body.data.totalPlatformFees).toBe(11.80);

      // Verify Bike fees in repository remain completely unchanged
      expect(inMemoryDb.bike.serviceCharge.value).toBe(2.40);
      expect(inMemoryDb.bike.convenienceFee.value).toBe(1.84);
      expect(inMemoryDb.bike.gst.value).toBe(18.00);
    });

    it('5. Updating Bike fees does NOT modify Car fees', async () => {
      const res = await request(app)
        .put('/api/v1/admin/platform-fee/bike')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`)
        .send({
          serviceCharge: 3.50,
          convenienceFee: 2.50,
          gst: 18.00,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(inMemoryDb.bike.serviceCharge.value).toBe(3.50);

      // Car fees must stay unchanged
      expect(inMemoryDb.car.serviceCharge.value).toBe(5.00);
      expect(inMemoryDb.car.convenienceFee.value).toBe(3.00);
      expect(inMemoryDb.car.gst.value).toBe(18.00);
    });

    it('6. Validation rejects negative car fees with 400', async () => {
      const res = await request(app)
        .put('/api/v1/admin/platform-fee/car')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`)
        .send({
          serviceCharge: -5.00,
          convenienceFee: 3.00,
          gst: 18.00,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('7. Validation rejects GST > 100 with 400', async () => {
      const res = await request(app)
        .put('/api/v1/admin/platform-fee/car')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`)
        .send({
          serviceCharge: 5.00,
          convenienceFee: 3.00,
          gst: 150.00,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('8. Customer cannot update car platform fees (403 Forbidden)', async () => {
      const res = await request(app)
        .put('/api/v1/admin/platform-fee/car')
        .set('Authorization', `Bearer ${SESSIONS.customer}`)
        .send({
          serviceCharge: 5.00,
          convenienceFee: 3.00,
          gst: 18.00,
        });

      expect(res.status).toBe(403);
    });

    it('9. Readonly admin cannot update car platform fees (403 Forbidden)', async () => {
      const res = await request(app)
        .put('/api/v1/admin/platform-fee/car')
        .set('Authorization', `Bearer ${SESSIONS.readonlyAdmin}`)
        .send({
          serviceCharge: 5.00,
          convenienceFee: 3.00,
          gst: 18.00,
        });

      expect(res.status).toBe(403);
    });
  });
});
