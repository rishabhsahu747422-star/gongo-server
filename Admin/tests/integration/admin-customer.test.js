'use strict';

const request = require('supertest');
const crypto = require('crypto');


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
const adminCustomerRepository = require('../../src/repositories/admin-customer.repository');
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

const CUSTOMERS_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000002',
  auth_id: 'sup-customers-admin',
  role: 'ADMIN',
  name: 'Customers Admin',
  email: 'customersadmin@gongo.in',
  is_active: true,
  permissions: [
    PERMISSIONS.CUSTOMERS_READ,
    PERMISSIONS.CUSTOMERS_UPDATE,
    PERMISSIONS.CUSTOMERS_SUSPEND,
  ],
};

const READ_ONLY_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000003',
  auth_id: 'sup-read-admin',
  role: 'ADMIN',
  name: 'Read Only Admin',
  email: 'readonly@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.CUSTOMERS_READ],
};

const UNAUTHORIZED_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000004',
  auth_id: 'sup-unauth-admin',
  role: 'ADMIN',
  name: 'No Customers Admin',
  email: 'nocustomers@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.PARTNERS_READ],
};

const DEACTIVATED_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000005',
  auth_id: 'sup-deactivated-admin',
  role: 'ADMIN',
  name: 'Deactivated Admin',
  email: 'deactivated@gongo.in',
  is_active: false,
  permissions: [PERMISSIONS.CUSTOMERS_READ],
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

const TEST_CUSTOMER_ID = 'c1111111-1111-4111-a111-111111111111';
const TEST_CUSTOMER = {
  id: TEST_CUSTOMER_ID,
  name: 'Aarav Patel',
  email: 'aarav@customer.in',
  phone: '9876543210',
  countryCode: '+91',
  avatarStorageKey: 'avatars/c111.png',
  isActive: true,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
};

const sessionsByHash = new Map();

function createMockSession(user) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(rawToken);
  const session = {
    id: `sess-${user.id}`,
    user_id: user.id,
    session_token: tokenHash,
    is_active: user.is_active !== false,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    last_active_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ip_address: '127.0.0.1',
    user_agent: 'Jest/Supertest',
  };

  sessionsByHash.set(tokenHash, session);
  return rawToken;
}

describe('Integration: Admin Customer Management (Phase 8)', () => {
  let superAdminToken;
  let customersAdminToken;
  let readOnlyAdminToken;
  let unauthorizedAdminToken;
  let deactivatedAdminToken;
  let customerToken;
  let partnerToken;

  beforeEach(() => {
    jest.restoreAllMocks();
    sessionsByHash.clear();

    jest.spyOn(adminSessionRepository, 'findByToken').mockImplementation(
      async (hash) => sessionsByHash.get(hash) || null,
    );

    jest.spyOn(adminSessionRepository, 'touchSession').mockResolvedValue(true);

    jest.spyOn(userRepository, 'findById').mockImplementation(async (id) => {
      const allUsers = [
        SUPER_ADMIN_USER,
        CUSTOMERS_ADMIN,
        READ_ONLY_ADMIN,
        UNAUTHORIZED_ADMIN,
        DEACTIVATED_ADMIN,
        CUSTOMER_USER,
        PARTNER_USER,
      ];
      const match = allUsers.find((x) => x.id === id);
      return match ? { ...match } : null;
    });

    jest.spyOn(adminPermissionRepository, 'findPermissionsByUserId').mockImplementation(
      async (adminId) => {
        const allUsers = [
          SUPER_ADMIN_USER,
          CUSTOMERS_ADMIN,
          READ_ONLY_ADMIN,
          UNAUTHORIZED_ADMIN,
          DEACTIVATED_ADMIN,
          CUSTOMER_USER,
          PARTNER_USER,
        ];
        const match = allUsers.find((x) => x.id === adminId);
        return match ? [...(match.permissions || [])] : [];
      },
    );

    superAdminToken = createMockSession(SUPER_ADMIN_USER);
    customersAdminToken = createMockSession(CUSTOMERS_ADMIN);
    readOnlyAdminToken = createMockSession(READ_ONLY_ADMIN);
    unauthorizedAdminToken = createMockSession(UNAUTHORIZED_ADMIN);
    deactivatedAdminToken = createMockSession(DEACTIVATED_ADMIN);
    customerToken = createMockSession(CUSTOMER_USER);
    partnerToken = createMockSession(PARTNER_USER);

    // Default repository mocks
    jest.spyOn(adminCustomerRepository, 'withTransaction').mockImplementation(async (cb) => cb({}));
    jest.spyOn(adminCustomerRepository, 'listCustomers').mockResolvedValue({
      customers: [{ ...TEST_CUSTOMER, bookingCount: 5, totalSpend: 15000 }],
      total: 1,
    });
    jest.spyOn(adminCustomerRepository, 'findCustomerById').mockImplementation(async (id) => {
      if (id === TEST_CUSTOMER_ID) return { ...TEST_CUSTOMER };
      return null;
    });
    jest.spyOn(adminCustomerRepository, 'getCustomerSummaries').mockResolvedValue({
      bookingSummary: { total: 10, upcoming: 1, active: 1, completed: 8, cancelled: 0 },
      paymentSummary: {
        totalPayments: 10,
        successfulPayments: 9,
        pendingPayments: 1,
        failedPayments: 0,
        totalSpent: 25000,
      },
      documentSummary: {
        totalDocuments: 2,
        verifiedDocuments: 2,
        pendingDocuments: 0,
        rejectedDocuments: 0,
      },
      addressCount: 2,
    });
    jest.spyOn(adminCustomerRepository, 'getActiveBookingCount').mockResolvedValue(0);
    jest.spyOn(adminCustomerRepository, 'updateCustomerStatus').mockResolvedValue({
      ...TEST_CUSTOMER,
      isActive: false,
    });
    jest.spyOn(adminCustomerRepository, 'getCustomerBookings').mockResolvedValue({
      bookings: [
        {
          id: 'bk-1',
          bookingNumber: 'BK-1001',
          customerId: TEST_CUSTOMER_ID,
          bookingStatus: 'COMPLETED',
        },
      ],
      total: 1,
    });
    jest.spyOn(adminCustomerRepository, 'getCustomerPayments').mockResolvedValue({
      payments: [
        {
          id: 'pay-1',
          customerId: TEST_CUSTOMER_ID,
          amount: 2500,
          status: 'SUCCESS',
        },
      ],
      total: 1,
    });
    jest.spyOn(adminCustomerRepository, 'getCustomerDocuments').mockResolvedValue([
      {
        id: 'doc-1',
        userId: TEST_CUSTOMER_ID,
        documentType: 'DRIVING_LICENSE',
        status: 'VERIFIED',
      },
    ]);
    jest.spyOn(adminCustomerRepository, 'getCustomerAddresses').mockResolvedValue([
      {
        id: 'addr-1',
        userId: TEST_CUSTOMER_ID,
        label: 'Home',
        city: 'Bengaluru',
      },
    ]);
    jest.spyOn(adminCustomerRepository, 'getCustomerActivity').mockResolvedValue({
      activity: [
        {
          id: 'act-1',
          action: 'CUSTOMER_SUSPEND',
          actorId: CUSTOMERS_ADMIN.id,
        },
      ],
      total: 1,
    });

    jest.spyOn(adminActionRepository, 'createAction').mockResolvedValue({ id: 'act-1' });
    jest.spyOn(auditService, 'logAdminAction').mockImplementation((evt) => evt);
  });

  // ==========================================================================
  // 1. GET /api/v1/admin/customers (List)
  // ==========================================================================
  describe('GET /api/v1/admin/customers', () => {
    it('returns 200 with customer list for authorized admin', async () => {
      const res = await request(app)
        .get('/api/v1/admin/customers')
        .set('Authorization', `Bearer ${customersAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.customers).toHaveLength(1);
      expect(res.body.data.customers[0].id).toBe(TEST_CUSTOMER_ID);
      expect(res.body.data.pagination.total).toBe(1);
    });

    it('returns 200 for SUPER_ADMIN bypass', async () => {
      const res = await request(app)
        .get('/api/v1/admin/customers')
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 403 when admin lacks customers.read permission', async () => {
      const res = await request(app)
        .get('/api/v1/admin/customers')
        .set('Authorization', `Bearer ${unauthorizedAdminToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('returns 403 when customer token is used', async () => {
      const res = await request(app)
        .get('/api/v1/admin/customers')
        .set('Authorization', `Bearer ${customerToken}`);

      expect(res.status).toBe(403);
    });

    it('returns 403 when partner token is used', async () => {
      const res = await request(app)
        .get('/api/v1/admin/customers')
        .set('Authorization', `Bearer ${partnerToken}`);

      expect(res.status).toBe(403);
    });

    it('returns 401 when deactivated admin tries to access', async () => {
      const res = await request(app)
        .get('/api/v1/admin/customers')
        .set('Authorization', `Bearer ${deactivatedAdminToken}`);

      expect(res.status).toBe(401);
    });

    it('returns 401 when no token is provided', async () => {
      const res = await request(app).get('/api/v1/admin/customers');
      expect(res.status).toBe(401);
    });

    it('supports search query parameter', async () => {
      const res = await request(app)
        .get('/api/v1/admin/customers?search=Aarav')
        .set('Authorization', `Bearer ${customersAdminToken}`);

      expect(res.status).toBe(200);
      expect(adminCustomerRepository.listCustomers).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'Aarav' }),
      );
    });

    it('supports isActive filter', async () => {
      const res = await request(app)
        .get('/api/v1/admin/customers?isActive=true')
        .set('Authorization', `Bearer ${customersAdminToken}`);

      expect(res.status).toBe(200);
      expect(adminCustomerRepository.listCustomers).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: true }),
      );
    });

    it('returns 400 for invalid isActive filter', async () => {
      const res = await request(app)
        .get('/api/v1/admin/customers?isActive=notabool')
        .set('Authorization', `Bearer ${customersAdminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('returns 400 for invalid date range (start >= end)', async () => {
      const res = await request(app)
        .get('/api/v1/admin/customers?startDate=2026-09-20&endDate=2026-09-10')
        .set('Authorization', `Bearer ${customersAdminToken}`);

      expect(res.status).toBe(400);
    });

    it('clamps excessive limit to 50', async () => {
      const res = await request(app)
        .get('/api/v1/admin/customers?limit=999')
        .set('Authorization', `Bearer ${customersAdminToken}`);

      expect(res.status).toBe(200);
      expect(adminCustomerRepository.listCustomers).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50 }),
      );
    });
  });

  // ==========================================================================
  // 2. GET /api/v1/admin/customers/:id (Detail)
  // ==========================================================================
  describe('GET /api/v1/admin/customers/:id', () => {
    it('returns 200 with customer detail and summaries for authorized admin', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/customers/${TEST_CUSTOMER_ID}`)
        .set('Authorization', `Bearer ${readOnlyAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.customer.id).toBe(TEST_CUSTOMER_ID);
      expect(res.body.data.bookingSummary.total).toBe(10);
      expect(res.body.data.paymentSummary.totalSpent).toBe(25000);
      expect(res.body.data.documentSummary.verifiedDocuments).toBe(2);
      expect(res.body.data.addressCount).toBe(2);
      expect(res.body.data.customer).not.toHaveProperty('password_hash');
    });

    it('returns 404 when customer does not exist', async () => {
      const nonExistentId = 'c9999999-9999-4999-a999-999999999999';
      const res = await request(app)
        .get(`/api/v1/admin/customers/${nonExistentId}`)
        .set('Authorization', `Bearer ${readOnlyAdminToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 400 when id is malformed (not UUID)', async () => {
      const res = await request(app)
        .get('/api/v1/admin/customers/not-a-uuid')
        .set('Authorization', `Bearer ${readOnlyAdminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 403 when admin lacks customers.read permission', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/customers/${TEST_CUSTOMER_ID}`)
        .set('Authorization', `Bearer ${unauthorizedAdminToken}`);

      expect(res.status).toBe(403);
    });
  });

  // ==========================================================================
  // 3. PATCH /api/v1/admin/customers/:id/status (Mutation)
  // ==========================================================================
  describe('PATCH /api/v1/admin/customers/:id/status', () => {
    it('returns 200 and updates status with audit log for authorized admin', async () => {
      const res = await request(app)
        .patch(`/api/v1/admin/customers/${TEST_CUSTOMER_ID}/status`)
        .set('Authorization', `Bearer ${customersAdminToken}`)
        .send({ isActive: false, reason: 'Suspicious account activity' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isActive).toBe(false);

      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: CUSTOMERS_ADMIN.id,
          action: 'CUSTOMER_SUSPEND',
          targetResource: 'CUSTOMER',
          targetResourceId: TEST_CUSTOMER_ID,
        }),
        expect.anything(),
      );
      expect(auditService.logAdminAction).toHaveBeenCalled();
    });

    it('returns 400 when deactivating customer with active bookings without force', async () => {
      jest.spyOn(adminCustomerRepository, 'getActiveBookingCount').mockResolvedValue(2);

      const res = await request(app)
        .patch(`/api/v1/admin/customers/${TEST_CUSTOMER_ID}/status`)
        .set('Authorization', `Bearer ${customersAdminToken}`)
        .send({ isActive: false });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('active/upcoming bookings');
    });

    it('returns 200 when deactivating customer with active bookings with force: true', async () => {
      jest.spyOn(adminCustomerRepository, 'getActiveBookingCount').mockResolvedValue(2);

      const res = await request(app)
        .patch(`/api/v1/admin/customers/${TEST_CUSTOMER_ID}/status`)
        .set('Authorization', `Bearer ${customersAdminToken}`)
        .send({ isActive: false, force: true });

      expect(res.status).toBe(200);
      expect(res.body.data.isActive).toBe(false);
    });

    it('returns 403 when admin has read-only permission', async () => {
      const res = await request(app)
        .patch(`/api/v1/admin/customers/${TEST_CUSTOMER_ID}/status`)
        .set('Authorization', `Bearer ${readOnlyAdminToken}`)
        .send({ isActive: false });

      expect(res.status).toBe(403);
    });

    it('rejects mass-assignment attempts with extra fields', async () => {
      const res = await request(app)
        .patch(`/api/v1/admin/customers/${TEST_CUSTOMER_ID}/status`)
        .set('Authorization', `Bearer ${customersAdminToken}`)
        .send({ isActive: false, role: 'ADMIN', email: 'hacked@gongo.in' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Field \'role\' is not allowed');
    });
  });

  // ==========================================================================
  // 4. Subresources (bookings, payments, documents, addresses, activity)
  // ==========================================================================
  describe('Subresources', () => {
    it('GET /bookings returns customer bookings', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/customers/${TEST_CUSTOMER_ID}/bookings`)
        .set('Authorization', `Bearer ${customersAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.bookings).toHaveLength(1);
      expect(res.body.data.pagination.total).toBe(1);
    });

    it('GET /payments returns customer payments', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/customers/${TEST_CUSTOMER_ID}/payments`)
        .set('Authorization', `Bearer ${customersAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.payments).toHaveLength(1);
      expect(res.body.data.pagination.total).toBe(1);
    });

    it('GET /documents returns customer documents safely', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/customers/${TEST_CUSTOMER_ID}/documents`)
        .set('Authorization', `Bearer ${customersAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.documents).toHaveLength(1);
      expect(res.body.data.documents[0].documentType).toBe('DRIVING_LICENSE');
    });

    it('GET /addresses returns customer saved addresses', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/customers/${TEST_CUSTOMER_ID}/addresses`)
        .set('Authorization', `Bearer ${customersAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.addresses).toHaveLength(1);
      expect(res.body.data.addresses[0].city).toBe('Bengaluru');
    });

    it('GET /activity returns customer activity audit log', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/customers/${TEST_CUSTOMER_ID}/activity`)
        .set('Authorization', `Bearer ${customersAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.activity).toHaveLength(1);
      expect(res.body.data.activity[0].action).toBe('CUSTOMER_SUSPEND');
    });
  });

  // ==========================================================================
  // 5. Security & Injection Tests
  // ==========================================================================
  describe('Security & Injection Protection', () => {
    it('ignores spoofed x-admin or x-role headers', async () => {
      const res = await request(app)
        .get('/api/v1/admin/customers')
        .set('Authorization', `Bearer ${unauthorizedAdminToken}`)
        .set('x-admin', 'true')
        .set('x-role', 'ADMIN');

      expect(res.status).toBe(403);
    });

    it('ignores customerId in body for BOLA/IDOR protection', async () => {
      const otherId = 'c2222222-2222-4222-a222-222222222222';
      const res = await request(app)
        .patch(`/api/v1/admin/customers/${TEST_CUSTOMER_ID}/status`)
        .set('Authorization', `Bearer ${customersAdminToken}`)
        .send({ id: otherId, customerId: otherId, isActive: false });

      // Mass assignment kicks in and rejects id / customerId
      expect(res.status).toBe(400);
    });

    it('rejects prototype pollution attempts', async () => {
      const res = await request(app)
        .patch(`/api/v1/admin/customers/${TEST_CUSTOMER_ID}/status`)
        .set('Authorization', `Bearer ${customersAdminToken}`)
        .send(JSON.parse('{"isActive": false, "constructor": {"admin": true}}'));

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });
});
