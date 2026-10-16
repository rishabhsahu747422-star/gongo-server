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
const adminPaymentRepository = require('../../src/repositories/admin-payment.repository');
const adminActionRepository = require('../../src/repositories/admin-action.repository');
const auditService = require('../../src/services/audit.service');
const cashfreeProvider = require('../../src/providers/cashfree');
const { hashSessionToken } = require('../../src/utils/crypto');
const { PERMISSIONS } = require('../../src/constants/permissions');
const { createApp } = require('../../src/app');

const app = createApp();

/**
 * Transaction client whose users table contains the authenticated admin (processed_by must
 * resolve to the actual actor — see security/financial-actor). Other queries return no rows.
 */
function actorClient() {
  return {
    query: jest.fn(async (sql, params) => (/FROM users/i.test(sql) ? { rows: [{ id: params[0] }] } : { rows: [] })),
  };
}

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
    PERMISSIONS.PAYMENTS_READ,
    PERMISSIONS.PAYMENTS_REFUND,
    PERMISSIONS.REFUNDS_READ,
    PERMISSIONS.REFUNDS_APPROVE,
    PERMISSIONS.COMMISSIONS_READ,
    PERMISSIONS.COMMISSIONS_UPDATE,
  ],
};

const READONLY_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000003',
  auth_id: 'sup-readonly-admin',
  role: 'ADMIN',
  name: 'Readonly Admin',
  email: 'readonlyadmin@gongo.in',
  is_active: true,
  permissions: [
    PERMISSIONS.PAYMENTS_READ,
    PERMISSIONS.REFUNDS_READ,
    PERMISSIONS.COMMISSIONS_READ,
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

const DEACTIVATED_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000005',
  auth_id: 'sup-deactivated-admin',
  role: 'ADMIN',
  name: 'Deactivated Admin',
  email: 'deactivated@gongo.in',
  is_active: false,
  permissions: [PERMISSIONS.SUPER_ADMIN],
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
  superAdmin: 'sess_superadmin_payment_token_001',
  financeAdmin: 'sess_financeadmin_payment_token_002',
  readonlyAdmin: 'sess_readonlyadmin_payment_token_003',
  noPermAdmin: 'sess_nopermadmin_payment_token_004',
  deactivatedAdmin: 'sess_deactivatedadmin_payment_token_005',
  customer: 'sess_customer_payment_token_006',
};

const TEST_PAYMENT_ID = 'e1111111-1111-4111-a111-111111111111';
const TEST_REFUND_ID = 'f1111111-1111-4111-a111-111111111111';
const TEST_BOOKING_ID = 'b1111111-1111-4111-a111-111111111111';
const TEST_COMMISSION_RULE_ID = 'c1111111-1111-4111-a111-111111111111';

describe('Integration: Admin Payments & Financial Operations (Phase 12)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cashfreeProvider.resetMockDelegate();

    // Session resolution mock
    jest.spyOn(adminSessionRepository, 'findByToken').mockImplementation(async (hash) => {
      const match = (token) => hash === hashSessionToken(token);
      let user = null;
      const sessionId = 'sess-active';

      if (match(SESSIONS.superAdmin)) user = SUPER_ADMIN_USER;
      else if (match(SESSIONS.financeAdmin)) user = FINANCE_ADMIN;
      else if (match(SESSIONS.readonlyAdmin)) user = READONLY_ADMIN;
      else if (match(SESSIONS.noPermAdmin)) user = NO_PERM_ADMIN;
      else if (match(SESSIONS.deactivatedAdmin)) user = DEACTIVATED_ADMIN;
      else if (match(SESSIONS.customer)) user = CUSTOMER_USER;

      if (!user) return null;

      return {
        id: sessionId,
        user_id: user.id,
        session_token: hash,
        is_active: user.is_active !== false,
        created_at: new Date(),
        last_active_at: new Date(),
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      };
    });

    jest.spyOn(adminSessionRepository, 'touchSession').mockResolvedValue(true);

    // User lookup mock
    jest.spyOn(userRepository, 'findById').mockImplementation(async (id) => {
      const allUsers = [
        SUPER_ADMIN_USER,
        FINANCE_ADMIN,
        READONLY_ADMIN,
        NO_PERM_ADMIN,
        DEACTIVATED_ADMIN,
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
        DEACTIVATED_ADMIN,
        CUSTOMER_USER,
      ];
      const found = allUsers.find((u) => u.id === id);
      return found ? found.permissions : [];
    });

    // Transaction mock
    jest.spyOn(adminPaymentRepository, 'executeInTransaction').mockImplementation(async (cb) => cb(actorClient()));

    // Audit logs mock
    jest.spyOn(adminActionRepository, 'createAction').mockResolvedValue({ id: 'action-uuid' });
    jest.spyOn(auditService, 'logAdminAction').mockResolvedValue({ id: 'action-uuid' });
  });

  afterEach(() => {
    cashfreeProvider.resetMockDelegate();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 1. AUTHENTICATION & ROLE GUARDS
  // ════════════════════════════════════════════════════════════════════════════

  describe('Authentication & Role Guards', () => {
    it('returns 401 Unauthorized when unauthenticated', async () => {
      const res = await request(app).get('/api/v1/admin/payments');
      expect(res.status).toBe(401);
    });

    it('returns 403 Forbidden when CUSTOMER token is used', async () => {
      const res = await request(app)
        .get('/api/v1/admin/payments')
        .set('Authorization', `Bearer ${SESSIONS.customer}`);
      expect(res.status).toBe(403);
    });

    it('returns 403/401 when deactivated admin token is used', async () => {
      const res = await request(app)
        .get('/api/v1/admin/payments')
        .set('Authorization', `Bearer ${SESSIONS.deactivatedAdmin}`);
      expect([401, 403]).toContain(res.status);
    });

    it('returns 403 Forbidden when admin lacks required payments.read permission', async () => {
      const res = await request(app)
        .get('/api/v1/admin/payments')
        .set('Authorization', `Bearer ${SESSIONS.noPermAdmin}`);
      expect(res.status).toBe(403);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 2. PAYMENT ENDPOINTS
  // ════════════════════════════════════════════════════════════════════════════

  describe('Payment Endpoints', () => {
    it('GET /api/v1/admin/payments lists payments with pagination and filters', async () => {
      jest.spyOn(adminPaymentRepository, 'listPayments').mockResolvedValue({
        payments: [
          {
            id: TEST_PAYMENT_ID,
            amount: 1500,
            status: 'SUCCESS',
            currency: 'INR',
          },
        ],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });

      const res = await request(app)
        .get('/api/v1/admin/payments?status=SUCCESS&page=1&limit=10')
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.payments).toHaveLength(1);
    });

    it('GET /api/v1/admin/payments/:id returns payment detail', async () => {
      jest.spyOn(adminPaymentRepository, 'getPaymentById').mockResolvedValue({
        id: TEST_PAYMENT_ID,
        amount: 2500,
        status: 'SUCCESS',
        booking: { id: TEST_BOOKING_ID, booking_number: 'GG-2026-0001' },
        customer: { id: 'c1', name: 'John Doe' },
        partner: { id: 'p1', business_name: 'Apex Wheels' },
      });

      const res = await request(app)
        .get(`/api/v1/admin/payments/${TEST_PAYMENT_ID}`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(TEST_PAYMENT_ID);
      expect(res.body.data.amount).toBe(2500);
    });

    it('GET /api/v1/admin/payments/:id/booking returns payment booking', async () => {
      jest.spyOn(adminPaymentRepository, 'getPaymentBooking').mockResolvedValue({
        id: TEST_BOOKING_ID,
        booking_number: 'GG-2026-0001',
      });

      const res = await request(app)
        .get(`/api/v1/admin/payments/${TEST_PAYMENT_ID}/booking`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.booking_number).toBe('GG-2026-0001');
    });

    it('GET /api/v1/admin/payments/:id/customer returns customer details', async () => {
      jest.spyOn(adminPaymentRepository, 'getPaymentCustomer').mockResolvedValue({
        id: 'c1',
        name: 'John Doe',
        email: 'john@example.com',
      });

      const res = await request(app)
        .get(`/api/v1/admin/payments/${TEST_PAYMENT_ID}/customer`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('John Doe');
    });

    it('GET /api/v1/admin/payments/:id/partner returns partner details', async () => {
      jest.spyOn(adminPaymentRepository, 'getPaymentPartner').mockResolvedValue({
        id: 'p1',
        business_name: 'Speedy Wheels',
      });

      const res = await request(app)
        .get(`/api/v1/admin/payments/${TEST_PAYMENT_ID}/partner`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.business_name).toBe('Speedy Wheels');
    });

    it('GET /api/v1/admin/payments/:id/timeline returns payment lifecycle milestones', async () => {
      jest.spyOn(adminPaymentRepository, 'getPaymentTimeline').mockResolvedValue([
        { event: 'PAYMENT_CREATED', status: 'CREATED', timestamp: new Date() },
        { event: 'PAYMENT_CONFIRMED', status: 'SUCCESS', timestamp: new Date() },
      ]);

      const res = await request(app)
        .get(`/api/v1/admin/payments/${TEST_PAYMENT_ID}/timeline`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });

    it('GET /api/v1/admin/payments/:id/transactions returns payment transactions', async () => {
      jest.spyOn(adminPaymentRepository, 'getPaymentTransactions').mockResolvedValue([
        { id: TEST_PAYMENT_ID, type: 'PAYMENT', amount: 1500, status: 'SUCCESS' },
      ]);

      const res = await request(app)
        .get(`/api/v1/admin/payments/${TEST_PAYMENT_ID}/transactions`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data[0].type).toBe('PAYMENT');
    });

    it('GET /api/v1/admin/payments/:id/webhooks returns payment webhook events', async () => {
      jest.spyOn(adminPaymentRepository, 'getPaymentWebhooks').mockResolvedValue([]);

      const res = await request(app)
        .get(`/api/v1/admin/payments/${TEST_PAYMENT_ID}/webhooks`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('POST /api/v1/admin/payments/:id/reconcile updates payment with Cashfree status', async () => {
      const mockPayment = {
        id: TEST_PAYMENT_ID,
        status: 'PENDING',
        provider_order_id: 'cf_ord_reconcile',
        amount: 2000,
      };

      jest.spyOn(adminPaymentRepository, 'executeInTransaction').mockImplementation(async (cb) => cb(actorClient()));
      jest.spyOn(adminPaymentRepository, 'getPaymentForUpdate').mockResolvedValue(mockPayment);
      jest.spyOn(adminPaymentRepository, 'updatePaymentStatus').mockResolvedValue({
        ...mockPayment,
        status: 'SUCCESS',
      });

      cashfreeProvider.setMockDelegate({
        getOrderStatus: jest.fn().mockResolvedValue({
          providerOrderId: 'cf_ord_reconcile',
          orderStatus: 'PAID',
          orderAmount: 2000,
          cfOrderId: 'cf_pay_rec_001',
        }),
      });

      const res = await request(app)
        .post(`/api/v1/admin/payments/${TEST_PAYMENT_ID}/reconcile`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.reconciled).toBe(true);
      expect(res.body.data.currentStatus).toBe('SUCCESS');
    });

    it('POST /api/v1/admin/payments/:id/refund executes refund transaction', async () => {
      const mockPayment = {
        id: TEST_PAYMENT_ID,
        booking_id: TEST_BOOKING_ID,
        customer_id: 'c1',
        status: 'SUCCESS',
        amount: 3000,
        provider_order_id: 'cf_ord_ref',
        currency: 'INR',
      };

      jest.spyOn(adminPaymentRepository, 'executeInTransaction').mockImplementation(async (cb) => cb(actorClient()));
      jest.spyOn(adminPaymentRepository, 'getPaymentForUpdate').mockResolvedValue(mockPayment);
      jest.spyOn(adminPaymentRepository, 'getPaymentRefundsSummary').mockResolvedValue({
        completedRefundAmount: 0,
        pendingRefundAmount: 0,
        totalRefundsCount: 0,
      });
      jest.spyOn(adminPaymentRepository, 'createRefund').mockResolvedValue({
        id: TEST_REFUND_ID,
        refund_number: 'REF-GG-0001',
        requested_amount: 1000,
        status: 'COMPLETED',
      });

      cashfreeProvider.setMockDelegate({
        createRefund: jest.fn().mockResolvedValue({
          providerRefundId: 'cf_ref_001',
          refundStatus: 'SUCCESS',
          refundAmount: 1000,
        }),
      });

      const res = await request(app)
        .post(`/api/v1/admin/payments/${TEST_PAYMENT_ID}/refund`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`)
        .send({ amount: 1000, reason: 'Booking cancelled with refund' });

      expect(res.status).toBe(201);
      expect(res.body.data.refund.id).toBe(TEST_REFUND_ID);
    });

    it('GET /api/v1/admin/payments/summary returns financial aggregates', async () => {
      jest.spyOn(adminPaymentRepository, 'getFinancialSummary').mockResolvedValue({
        currency: 'INR',
        payments: { total: 50, successful: 40, failed: 8, pending: 2, totalCollectedAmount: 80000 },
        refunds: { total: 4, completed: 4, totalRefundedAmount: 5000 },
        commissions: { totalCommissionAmount: 12000, totalPartnerPayableAmount: 68000 },
      });

      const res = await request(app)
        .get('/api/v1/admin/payments/summary')
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.payments.total).toBe(50);
      expect(res.body.data.refunds.totalRefundedAmount).toBe(5000);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 3. REFUND ENDPOINTS
  // ════════════════════════════════════════════════════════════════════════════

  describe('Refund Endpoints', () => {
    it('GET /api/v1/admin/refunds lists refunds with filters', async () => {
      jest.spyOn(adminPaymentRepository, 'listRefunds').mockResolvedValue({
        refunds: [
          {
            id: TEST_REFUND_ID,
            refund_number: 'REF-GG-0001',
            status: 'REQUESTED',
            requested_amount: 500,
          },
        ],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });

      const res = await request(app)
        .get('/api/v1/admin/refunds?status=REQUESTED')
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.refunds).toHaveLength(1);
    });

    it('GET /api/v1/admin/refunds/:id returns refund detail', async () => {
      jest.spyOn(adminPaymentRepository, 'getRefundById').mockResolvedValue({
        id: TEST_REFUND_ID,
        refund_number: 'REF-GG-0001',
        status: 'REQUESTED',
        requested_amount: 500,
        booking: { id: TEST_BOOKING_ID, booking_number: 'GG-2026-0001' },
        customer: { id: 'c1', name: 'Customer A' },
        payment: { id: TEST_PAYMENT_ID, amount: 2000 },
      });

      const res = await request(app)
        .get(`/api/v1/admin/refunds/${TEST_REFUND_ID}`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(TEST_REFUND_ID);
    });

    it('POST /api/v1/admin/refunds/:id/approve approves refund', async () => {
      const mockRefund = {
        id: TEST_REFUND_ID,
        payment_id: TEST_PAYMENT_ID,
        refund_number: 'REF-GG-0001',
        requested_amount: 500,
        status: 'REQUESTED',
      };
      const mockPayment = {
        id: TEST_PAYMENT_ID,
        amount: 2000,
        provider_order_id: 'cf_ord_001',
      };

      jest.spyOn(adminPaymentRepository, 'executeInTransaction').mockImplementation(async (cb) => cb(actorClient()));
      jest.spyOn(adminPaymentRepository, 'getRefundForUpdate').mockResolvedValue(mockRefund);
      jest.spyOn(adminPaymentRepository, 'getPaymentForUpdate').mockResolvedValue(mockPayment);
      jest.spyOn(adminPaymentRepository, 'getPaymentRefundsSummary').mockResolvedValue({
        completedRefundAmount: 0,
        pendingRefundAmount: 500,
        totalRefundsCount: 1,
      });
      jest.spyOn(adminPaymentRepository, 'updateRefundStatus').mockResolvedValue({
        ...mockRefund,
        status: 'COMPLETED',
        approved_amount: 500,
        refunded_amount: 500,
      });

      cashfreeProvider.setMockDelegate({
        createRefund: jest.fn().mockResolvedValue({
          providerRefundId: 'cf_ref_app_001',
          refundStatus: 'SUCCESS',
          refundAmount: 500,
        }),
      });

      const res = await request(app)
        .post(`/api/v1/admin/refunds/${TEST_REFUND_ID}/approve`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('COMPLETED');
    });

    it('POST /api/v1/admin/refunds/:id/reject rejects refund with reason', async () => {
      const mockRefund = {
        id: TEST_REFUND_ID,
        status: 'REQUESTED',
      };

      jest.spyOn(adminPaymentRepository, 'executeInTransaction').mockImplementation(async (cb) => cb(actorClient()));
      jest.spyOn(adminPaymentRepository, 'getRefundForUpdate').mockResolvedValue(mockRefund);
      jest.spyOn(adminPaymentRepository, 'updateRefundStatus').mockResolvedValue({
        ...mockRefund,
        status: 'REJECTED',
        rejection_reason: 'Violation of cancellation notice window',
      });

      const res = await request(app)
        .post(`/api/v1/admin/refunds/${TEST_REFUND_ID}/reject`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`)
        .send({ reason: 'Violation of cancellation notice window' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('REJECTED');
    });

    it('POST /api/v1/admin/refunds/:id/reject requires reason', async () => {
      const res = await request(app)
        .post(`/api/v1/admin/refunds/${TEST_REFUND_ID}/reject`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`)
        .send({});

      expect(res.status).toBe(400);
    });

    it('POST /api/v1/admin/refunds/:id/process routes to reject when decision=reject', async () => {
      const mockRefund = {
        id: TEST_REFUND_ID,
        status: 'REQUESTED',
      };

      jest.spyOn(adminPaymentRepository, 'executeInTransaction').mockImplementation(async (cb) => cb(actorClient()));
      jest.spyOn(adminPaymentRepository, 'getRefundForUpdate').mockResolvedValue(mockRefund);
      jest.spyOn(adminPaymentRepository, 'updateRefundStatus').mockResolvedValue({
        ...mockRefund,
        status: 'REJECTED',
        rejection_reason: 'Non-refundable time window',
      });

      const res = await request(app)
        .post(`/api/v1/admin/refunds/${TEST_REFUND_ID}/process`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`)
        .send({ decision: 'reject', reason: 'Non-refundable time window' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('REJECTED');
    });

    it('POST /api/v1/admin/refunds/:id/process executes manual refund with UTR', async () => {
      const mockRefund = {
        id: TEST_REFUND_ID,
        payment_id: TEST_PAYMENT_ID,
        refund_number: 'REF-GG-0005',
        requested_amount: 800,
        status: 'REQUESTED',
      };
      const mockPayment = {
        id: TEST_PAYMENT_ID,
        amount: 2000,
      };

      jest.spyOn(adminPaymentRepository, 'executeInTransaction').mockImplementation(async (cb) => cb(actorClient()));
      jest.spyOn(adminPaymentRepository, 'getRefundForUpdate').mockResolvedValue(mockRefund);
      jest.spyOn(adminPaymentRepository, 'getPaymentForUpdate').mockResolvedValue(mockPayment);
      jest.spyOn(adminPaymentRepository, 'getPaymentRefundsSummary').mockResolvedValue({
        completedRefundAmount: 0,
        pendingRefundAmount: 800,
        totalRefundsCount: 1,
      });
      jest.spyOn(adminPaymentRepository, 'updateRefundStatus').mockResolvedValue({
        ...mockRefund,
        status: 'COMPLETED',
        approved_amount: 800,
        refunded_amount: 800,
        utr: 'NEFT99887766',
        payment_method: 'MANUAL',
      });

      const res = await request(app)
        .post(`/api/v1/admin/refunds/${TEST_REFUND_ID}/process`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`)
        .send({
          refundMethod: 'MANUAL',
          approvedAmount: 800,
          utr: 'NEFT99887766',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('COMPLETED');
      expect(res.body.data.utr).toBe('NEFT99887766');
    });

    it('POST /api/v1/admin/refunds/:id/process rejects approvedAmount=0 with actionable message', async () => {
      const mockRefund = {
        id: TEST_REFUND_ID,
        payment_id: TEST_PAYMENT_ID,
        requested_amount: 800,
        status: 'REQUESTED',
      };
      const mockPayment = {
        id: TEST_PAYMENT_ID,
        amount: 2000,
      };

      jest.spyOn(adminPaymentRepository, 'executeInTransaction').mockImplementation(async (cb) => cb(actorClient()));
      jest.spyOn(adminPaymentRepository, 'getRefundForUpdate').mockResolvedValue(mockRefund);
      jest.spyOn(adminPaymentRepository, 'getPaymentForUpdate').mockResolvedValue(mockPayment);

      const res = await request(app)
        .post(`/api/v1/admin/refunds/${TEST_REFUND_ID}/process`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`)
        .send({
          approvedAmount: 0,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Approved amount must be greater than zero');
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 4. COMMISSION ENDPOINTS
  // ════════════════════════════════════════════════════════════════════════════

  describe('Commission Endpoints', () => {
    it('GET /api/v1/admin/commissions lists commissions', async () => {
      jest.spyOn(adminPaymentRepository, 'listCommissions').mockResolvedValue({
        commissions: [
          {
            id: 'cr-1',
            booking_id: TEST_BOOKING_ID,
            commission_amount: '300.00',
            status: 'CALCULATED',
          },
        ],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });

      const res = await request(app)
        .get('/api/v1/admin/commissions')
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.commissions).toHaveLength(1);
    });

    it('GET /api/v1/admin/commissions/rules lists rules', async () => {
      jest.spyOn(adminPaymentRepository, 'listCommissionRules').mockResolvedValue({
        rules: [
          {
            id: TEST_COMMISSION_RULE_ID,
            name: 'Default Tier',
            rule_scope: 'default',
            commission_value: 15.0,
          },
        ],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });

      const res = await request(app)
        .get('/api/v1/admin/commissions/rules')
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.rules).toHaveLength(1);
    });

    it('POST /api/v1/admin/commissions/rules creates rule', async () => {
      jest.spyOn(adminPaymentRepository, 'createCommissionRule').mockResolvedValue({
        id: TEST_COMMISSION_RULE_ID,
        name: 'Partner Special Tier',
        rule_scope: 'partner',
        commission_value: 12.5,
        priority: 25,
      });

      const res = await request(app)
        .post('/api/v1/admin/commissions/rules')
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`)
        .send({
          name: 'Partner Special Tier',
          ruleScope: 'partner',
          commissionType: 'percentage',
          commissionValue: 12.5,
          priority: 25,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe(TEST_COMMISSION_RULE_ID);
    });

    it('PATCH /api/v1/admin/commissions/rules/:id updates rule', async () => {
      jest.spyOn(adminPaymentRepository, 'getCommissionRuleById').mockResolvedValue({
        id: TEST_COMMISSION_RULE_ID,
        name: 'Old Rule',
        commission_value: 10,
      });
      jest.spyOn(adminPaymentRepository, 'updateCommissionRule').mockResolvedValue({
        id: TEST_COMMISSION_RULE_ID,
        name: 'Updated Rule',
        commission_value: 14.5,
      });

      const res = await request(app)
        .patch(`/api/v1/admin/commissions/rules/${TEST_COMMISSION_RULE_ID}`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`)
        .send({ name: 'Updated Rule', commissionValue: 14.5 });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Updated Rule');
    });

    it('GET /api/v1/admin/commissions/rules/targets returns available targets', async () => {
      jest.spyOn(adminPaymentRepository, 'getCommissionRuleTargets').mockResolvedValue({
        categories: [{ id: '032f4a5c-ac79-4f3b-8d30-61eb49462212', name: 'Bike' }],
        partners: [{ id: '4b696412-7f55-4f61-8a38-16f143a7c0e2', name: 'Partner Hub' }],
        vehicles: [{ id: 'dc7fa6fc-9494-4259-8fc3-e038a353204e', name: 'KA01DEV9998' }],
      });

      const res = await request(app)
        .get('/api/v1/admin/commissions/rules/targets')
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.categories).toHaveLength(1);
      expect(res.body.data.partners).toHaveLength(1);
    });

    it('DELETE /api/v1/admin/commission-rules/:id deletes rule', async () => {
      jest.spyOn(adminPaymentRepository, 'getCommissionRuleById').mockResolvedValue({
        id: TEST_COMMISSION_RULE_ID,
        name: 'To Delete',
      });
      jest.spyOn(adminPaymentRepository, 'deleteCommissionRule').mockResolvedValue({
        id: TEST_COMMISSION_RULE_ID,
      });

      const res = await request(app)
        .delete(`/api/v1/admin/commission-rules/${TEST_COMMISSION_RULE_ID}`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.meta.message).toContain('deleted successfully');
    });

    it('GET /api/v1/admin/finance/summary returns consolidated financial summary', async () => {
      jest.spyOn(adminPaymentRepository, 'getFinancialSummary').mockResolvedValue({
        currency: 'INR',
        payments: { total: 200, successful: 180, totalCollectedAmount: 360000 },
        refunds: { total: 10, totalRefundedAmount: 15000 },
        commissions: { totalCommissionAmount: 54000, totalPartnerPayableAmount: 306000 },
      });

      const res = await request(app)
        .get('/api/v1/admin/finance/summary')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.payments.total).toBe(200);
    });
  });
});
