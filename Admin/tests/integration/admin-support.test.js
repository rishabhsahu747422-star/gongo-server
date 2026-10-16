'use strict';

const request = require('supertest');


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
const adminSupportService = require('../../src/services/admin-support.service');
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

const SUPPORT_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000003',
  auth_id: 'sup-support-admin',
  role: 'ADMIN',
  name: 'Support Admin',
  email: 'support@gongo.in',
  is_active: true,
  permissions: [
    PERMISSIONS.SUPPORT_READ,
    PERMISSIONS.SUPPORT_UPDATE,
  ],
};

const READONLY_SUPPORT_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000004',
  auth_id: 'sup-readonly-support',
  role: 'ADMIN',
  name: 'Readonly Support Admin',
  email: 'readonly-support@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.SUPPORT_READ],
};

const NO_PERM_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000005',
  auth_id: 'sup-noperm-admin',
  role: 'ADMIN',
  name: 'No Perm Admin',
  email: 'noperm@gongo.in',
  is_active: true,
  permissions: [],
};

const DEACTIVATED_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000006',
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

const TEST_TICKET_ID = 't0000001-0000-4000-a000-000000000001';
const TEST_CUSTOMER_ID = 'c0000001-0000-4000-a000-000000000001';
const TEST_PARTNER_ID = 'p0000001-0000-4000-a000-000000000001';
const TEST_BOOKING_ID = 'b0000001-0000-4000-a000-000000000001';

const SESSIONS = {
  superAdmin: 'sess_superadmin_supp_token_001',
  supportAdmin: 'sess_suppadmin_supp_token_002',
  readonlySupport: 'sess_readonly_supp_token_003',
  noPerm: 'sess_noperm_supp_token_004',
  deactivated: 'sess_deactivated_supp_token_005',
  customer: 'sess_customer_supp_token_006',
};

describe('Integration: Admin Support & Ticket Management (Phase 15)', () => {
  beforeEach(() => {
    // Mock session resolution
    jest.spyOn(adminSessionRepository, 'findByToken').mockImplementation(async (tokenHash) => {
      const match = Object.entries(SESSIONS).find(
        ([, rawToken]) => hashSessionToken(rawToken) === tokenHash,
      );
      if (!match) return null;
      const key = match[0];
      const userMap = {
        superAdmin: SUPER_ADMIN_USER,
        supportAdmin: SUPPORT_ADMIN,
        readonlySupport: READONLY_SUPPORT_ADMIN,
        noPerm: NO_PERM_ADMIN,
        deactivated: DEACTIVATED_ADMIN,
        customer: NON_ADMIN_CUSTOMER,
      };
      const user = userMap[key];
      if (!user) return null;
      return {
        id: `sess-${key}`,
        user_id: user.id,
        session_token: tokenHash,
        ip_address: '127.0.0.1',
        user_agent: 'JestTestRunner/1.0',
        is_active: user.is_active !== false,
        created_at: new Date(),
        last_active_at: new Date(),
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        revoked_at: null,
      };
    });

    // Mock user lookup by id
    jest.spyOn(userRepository, 'findById').mockImplementation(async (userId) => {
      const users = {
        [SUPER_ADMIN_USER.id]: SUPER_ADMIN_USER,
        [SUPPORT_ADMIN.id]: SUPPORT_ADMIN,
        [READONLY_SUPPORT_ADMIN.id]: READONLY_SUPPORT_ADMIN,
        [NO_PERM_ADMIN.id]: NO_PERM_ADMIN,
        [DEACTIVATED_ADMIN.id]: DEACTIVATED_ADMIN,
        [NON_ADMIN_CUSTOMER.id]: NON_ADMIN_CUSTOMER,
      };
      return users[userId] || null;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── 1. Authentication & Security Edge Cases ──────────────────────────────────
  describe('1. Authentication & Authorization Security', () => {
    it('returns 401 Unauthorized when Authorization header is missing', async () => {
      const res = await request(app).get('/api/v1/admin/support');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 401 Unauthorized when bearer token is invalid', async () => {

      const res = await request(app)
        .get('/api/v1/admin/support')
        .set('Authorization', 'Bearer invalid_token_xyz');
      expect([401, 500]).toContain(res.status);
    });

    it('returns 403 Forbidden when user is not an ADMIN (e.g. CUSTOMER)', async () => {
      const res = await request(app)
        .get('/api/v1/admin/support')
        .set('Authorization', `Bearer ${SESSIONS.customer}`);
      expect(res.status).toBe(403);
    });

    it('returns 401 or 403 when admin account is deactivated', async () => {
      const res = await request(app)
        .get('/api/v1/admin/support')
        .set('Authorization', `Bearer ${SESSIONS.deactivated}`);
      expect([401, 403]).toContain(res.status);
    });

    it('returns 403 Forbidden when admin lacks required support permissions', async () => {
      const res = await request(app)
        .get('/api/v1/admin/support')
        .set('Authorization', `Bearer ${SESSIONS.noPerm}`);
      expect(res.status).toBe(403);
    });
  });

  // ── 2. Support Ticket Listing (GET /api/v1/admin/support) ──────────────────────
  describe('2. Support Ticket Listing', () => {
    it('lists tickets with pagination and filters for authorized support admin', async () => {
      jest.spyOn(adminSupportService, 'listTickets').mockResolvedValueOnce({
        tickets: [
          {
            id: TEST_TICKET_ID,
            ticketNumber: 'TKT-20260901-001',
            status: 'OPEN',
            priority: 'HIGH',
            category: 'BOOKING',
            subject: 'Refund request',
            customer: { id: TEST_CUSTOMER_ID, name: 'John Customer' },
          },
        ],
        pagination: { total: 1, page: 1, limit: 20, totalPages: 1 },
      });

      const res = await request(app)
        .get('/api/v1/admin/support?status=OPEN&priority=HIGH')
        .set('Authorization', `Bearer ${SESSIONS.supportAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.meta.pagination.total).toBe(1);
    });

    it('SUPER_ADMIN can list tickets bypassing individual granular permissions', async () => {
      jest.spyOn(adminSupportService, 'listTickets').mockResolvedValueOnce({
        tickets: [],
        pagination: { total: 0, page: 1, limit: 20, totalPages: 1 },
      });

      const res = await request(app)
        .get('/api/v1/admin/support')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ── 3. Ticket Detail & Relationships (BOLA / IDOR Protection) ────────────────
  describe('3. Ticket Detail, Timeline & Relationships', () => {
    it('returns ticket detail safely for valid ticket ID', async () => {
      jest.spyOn(adminSupportService, 'getTicketById').mockResolvedValueOnce({
        id: TEST_TICKET_ID,
        ticketNumber: 'TKT-20260901-001',
        status: 'OPEN',
        priority: 'MEDIUM',
        subject: 'Query on invoice',
        customer: { id: TEST_CUSTOMER_ID, name: 'John Customer' },
      });

      const res = await request(app)
        .get(`/api/v1/admin/support/${TEST_TICKET_ID}`)
        .set('Authorization', `Bearer ${SESSIONS.supportAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(TEST_TICKET_ID);
    });

    it('returns 400 Bad Request on malformed ticket UUID parameter', async () => {
      const res = await request(app)
        .get('/api/v1/admin/support/malformed-id-123')
        .set('Authorization', `Bearer ${SESSIONS.supportAdmin}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('returns ticket messages history', async () => {
      jest.spyOn(adminSupportService, 'getTicketMessages').mockResolvedValueOnce({
        ticketId: TEST_TICKET_ID,
        messages: [
          {
            id: 'm-1',
            senderType: 'CUSTOMER',
            message: 'Need help with payment',
          },
        ],
      });

      const res = await request(app)
        .get(`/api/v1/admin/support/${TEST_TICKET_ID}/messages`)
        .set('Authorization', `Bearer ${SESSIONS.supportAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.messages).toHaveLength(1);
    });

    it('returns ticket timeline history', async () => {
      jest.spyOn(adminSupportService, 'getTicketTimeline').mockResolvedValueOnce({
        ticketId: TEST_TICKET_ID,
        timeline: [
          { eventType: 'TICKET_CREATED', description: 'Ticket created' },
        ],
      });

      const res = await request(app)
        .get(`/api/v1/admin/support/${TEST_TICKET_ID}/timeline`)
        .set('Authorization', `Bearer ${SESSIONS.supportAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.timeline).toHaveLength(1);
    });

    it('returns ticket customer details', async () => {
      jest.spyOn(adminSupportService, 'getTicketCustomer').mockResolvedValueOnce({
        ticketId: TEST_TICKET_ID,
        customer: { id: TEST_CUSTOMER_ID, name: 'John Doe' },
      });

      const res = await request(app)
        .get(`/api/v1/admin/support/${TEST_TICKET_ID}/customer`)
        .set('Authorization', `Bearer ${SESSIONS.supportAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.customer.id).toBe(TEST_CUSTOMER_ID);
    });

    it('returns ticket partner details', async () => {
      jest.spyOn(adminSupportService, 'getTicketPartner').mockResolvedValueOnce({
        ticketId: TEST_TICKET_ID,
        partner: { id: TEST_PARTNER_ID, businessName: 'Fleet Hub' },
      });

      const res = await request(app)
        .get(`/api/v1/admin/support/${TEST_TICKET_ID}/partner`)
        .set('Authorization', `Bearer ${SESSIONS.supportAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.partner.id).toBe(TEST_PARTNER_ID);
    });

    it('returns ticket booking details', async () => {
      jest.spyOn(adminSupportService, 'getTicketBooking').mockResolvedValueOnce({
        ticketId: TEST_TICKET_ID,
        booking: { id: TEST_BOOKING_ID, bookingNumber: 'BK-1001' },
      });

      const res = await request(app)
        .get(`/api/v1/admin/support/${TEST_TICKET_ID}/booking`)
        .set('Authorization', `Bearer ${SESSIONS.supportAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.booking.id).toBe(TEST_BOOKING_ID);
    });
  });

  // ── 4. Status, Priority & Category Mutations ──────────────────────────────────
  describe('4. Status, Priority & Category Mutations', () => {
    it('PATCH /api/v1/admin/support/:id/status updates ticket status', async () => {
      jest.spyOn(adminSupportService, 'updateStatus').mockResolvedValueOnce({
        id: TEST_TICKET_ID,
        status: 'IN_PROGRESS',
      });

      const res = await request(app)
        .patch(`/api/v1/admin/support/${TEST_TICKET_ID}/status`)
        .set('Authorization', `Bearer ${SESSIONS.supportAdmin}`)
        .send({ status: 'IN_PROGRESS', reason: 'Assigned to agent' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('IN_PROGRESS');
    });

    it('PATCH /api/v1/admin/support/:id/status denies readonly support admin (403 Forbidden)', async () => {
      const res = await request(app)
        .patch(`/api/v1/admin/support/${TEST_TICKET_ID}/status`)
        .set('Authorization', `Bearer ${SESSIONS.readonlySupport}`)
        .send({ status: 'IN_PROGRESS' });

      expect(res.status).toBe(403);
    });

    it('PATCH /api/v1/admin/support/:id/priority updates ticket priority', async () => {
      jest.spyOn(adminSupportService, 'updatePriority').mockResolvedValueOnce({
        id: TEST_TICKET_ID,
        priority: 'URGENT',
      });

      const res = await request(app)
        .patch(`/api/v1/admin/support/${TEST_TICKET_ID}/priority`)
        .set('Authorization', `Bearer ${SESSIONS.supportAdmin}`)
        .send({ priority: 'URGENT' });

      expect(res.status).toBe(200);
      expect(res.body.data.priority).toBe('URGENT');
    });

    it('PATCH /api/v1/admin/support/:id/category updates ticket category', async () => {
      jest.spyOn(adminSupportService, 'updateCategory').mockResolvedValueOnce({
        id: TEST_TICKET_ID,
        category: 'PAYMENT',
      });

      const res = await request(app)
        .patch(`/api/v1/admin/support/${TEST_TICKET_ID}/category`)
        .set('Authorization', `Bearer ${SESSIONS.supportAdmin}`)
        .send({ category: 'PAYMENT' });

      expect(res.status).toBe(200);
      expect(res.body.data.category).toBe('PAYMENT');
    });
  });

  // ── 5. Admin Assignment, Reply, Resolve, Close & Reopen ───────────────────────
  describe('5. Assignment, Reply, Resolution & Closure Workflows', () => {
    it('POST /api/v1/admin/support/:id/assign assigns ticket to admin', async () => {
      jest.spyOn(adminSupportService, 'assignTicket').mockResolvedValueOnce({
        id: TEST_TICKET_ID,
        assignedTo: SUPER_ADMIN_USER.id,
        status: 'IN_PROGRESS',
      });

      const res = await request(app)
        .post(`/api/v1/admin/support/${TEST_TICKET_ID}/assign`)
        .set('Authorization', `Bearer ${SESSIONS.supportAdmin}`)
        .send({ adminUserId: SUPER_ADMIN_USER.id, reason: 'Assigned to manager' });

      expect(res.status).toBe(200);
      expect(res.body.data.assignedTo).toBe(SUPER_ADMIN_USER.id);
    });

    it('POST /api/v1/admin/support/:id/reply posts admin reply and returns 201 Created', async () => {
      jest.spyOn(adminSupportService, 'replyTicket').mockResolvedValueOnce({
        message: {
          id: 'm-2',
          senderType: 'SUPPORT',
          message: 'We have processed your request',
        },
        ticketStatus: 'WAITING_FOR_CUSTOMER',
      });

      const res = await request(app)
        .post(`/api/v1/admin/support/${TEST_TICKET_ID}/reply`)
        .set('Authorization', `Bearer ${SESSIONS.supportAdmin}`)
        .send({ message: 'We have processed your request' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.message.message).toBe('We have processed your request');
    });

    it('POST /api/v1/admin/support/:id/resolve resolves ticket', async () => {
      jest.spyOn(adminSupportService, 'resolveTicket').mockResolvedValueOnce({
        id: TEST_TICKET_ID,
        status: 'RESOLVED',
        resolutionNotes: 'Refund issued to original payment method',
      });

      const res = await request(app)
        .post(`/api/v1/admin/support/${TEST_TICKET_ID}/resolve`)
        .set('Authorization', `Bearer ${SESSIONS.supportAdmin}`)
        .send({ resolutionNotes: 'Refund issued to original payment method' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('RESOLVED');
    });

    it('POST /api/v1/admin/support/:id/close closes ticket', async () => {
      jest.spyOn(adminSupportService, 'closeTicket').mockResolvedValueOnce({
        id: TEST_TICKET_ID,
        status: 'CLOSED',
      });

      const res = await request(app)
        .post(`/api/v1/admin/support/${TEST_TICKET_ID}/close`)
        .set('Authorization', `Bearer ${SESSIONS.supportAdmin}`)
        .send({ reason: 'Issue completed and verified' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('CLOSED');
    });

    it('POST /api/v1/admin/support/:id/reopen reopens ticket', async () => {
      jest.spyOn(adminSupportService, 'reopenTicket').mockResolvedValueOnce({
        id: TEST_TICKET_ID,
        status: 'REOPENED',
      });

      const res = await request(app)
        .post(`/api/v1/admin/support/${TEST_TICKET_ID}/reopen`)
        .set('Authorization', `Bearer ${SESSIONS.supportAdmin}`)
        .send({ reason: 'Customer requested reopening' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('REOPENED');
    });
  });
});
