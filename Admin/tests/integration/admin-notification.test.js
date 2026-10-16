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
const adminNotificationService = require('../../src/services/admin-notification.service');
const { hashSessionToken } = require('../../src/utils/crypto');
const { PERMISSIONS } = require('../../src/constants/permissions');
const { ForbiddenError } = require('../../src/errors');
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

const NOTIF_READ_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000002',
  auth_id: 'sup-read-admin',
  role: 'ADMIN',
  name: 'Read Notif Admin',
  email: 'readnotif@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.NOTIFICATIONS_READ],
};

const NOTIF_MANAGE_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000003',
  auth_id: 'sup-manage-admin',
  role: 'ADMIN',
  name: 'Manage Notif Admin',
  email: 'managenotif@gongo.in',
  is_active: true,
  permissions: [
    PERMISSIONS.NOTIFICATIONS_READ,
    PERMISSIONS.NOTIFICATIONS_MANAGE,
  ],
};

const NOTIF_SEND_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000004',
  auth_id: 'sup-send-admin',
  role: 'ADMIN',
  name: 'Send Notif Admin',
  email: 'sendnotif@gongo.in',
  is_active: true,
  permissions: [
    PERMISSIONS.NOTIFICATIONS_READ,
    PERMISSIONS.NOTIFICATIONS_SEND,
  ],
};

const FULL_NOTIF_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000005',
  auth_id: 'sup-full-admin',
  role: 'ADMIN',
  name: 'Full Notif Admin',
  email: 'fullnotif@gongo.in',
  is_active: true,
  permissions: [
    PERMISSIONS.NOTIFICATIONS_READ,
    PERMISSIONS.NOTIFICATIONS_MANAGE,
    PERMISSIONS.NOTIFICATIONS_SEND,
  ],
};

const NO_PERM_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000006',
  auth_id: 'sup-noperm-admin',
  role: 'ADMIN',
  name: 'No Perm Admin',
  email: 'noperm@gongo.in',
  is_active: true,
  permissions: [],
};

const DEACTIVATED_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000007',
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

const TEST_NOTIFICATION_ID = 'da000001-0000-4000-a000-000000000001';
const TEST_TEMPLATE_ID = 'ea000001-0000-4000-a000-000000000001';
const TEST_CUSTOMER_ID = 'c0000001-0000-4000-a000-000000000001';
const TEST_PARTNER_ID = 'ba000001-0000-4000-a000-000000000001';
const TEST_BOOKING_ID = 'ca000001-0000-4000-a000-000000000001';

const SESSIONS = {
  superAdmin: 'sess_superadmin_notif_token_001',
  readAdmin: 'sess_readadmin_notif_token_002',
  manageAdmin: 'sess_manageadmin_notif_token_003',
  sendAdmin: 'sess_sendadmin_notif_token_004',
  fullAdmin: 'sess_fulladmin_notif_token_005',
  noPerm: 'sess_noperm_notif_token_006',
  deactivated: 'sess_deactivated_notif_token_007',
  customer: 'sess_customer_notif_token_008',
};

describe('Integration: Admin Notifications & Communication (Phase 16)', () => {
  beforeEach(() => {
    jest.spyOn(adminSessionRepository, 'findByToken').mockImplementation(async (tokenHash) => {
      const match = Object.entries(SESSIONS).find(
        ([, rawToken]) => hashSessionToken(rawToken) === tokenHash,
      );
      if (!match) return null;
      const key = match[0];
      const userMap = {
        superAdmin: SUPER_ADMIN_USER,
        readAdmin: NOTIF_READ_ADMIN,
        manageAdmin: NOTIF_MANAGE_ADMIN,
        sendAdmin: NOTIF_SEND_ADMIN,
        fullAdmin: FULL_NOTIF_ADMIN,
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

    jest.spyOn(userRepository, 'findById').mockImplementation(async (userId) => {
      const users = {
        [SUPER_ADMIN_USER.id]: SUPER_ADMIN_USER,
        [NOTIF_READ_ADMIN.id]: NOTIF_READ_ADMIN,
        [NOTIF_MANAGE_ADMIN.id]: NOTIF_MANAGE_ADMIN,
        [NOTIF_SEND_ADMIN.id]: NOTIF_SEND_ADMIN,
        [FULL_NOTIF_ADMIN.id]: FULL_NOTIF_ADMIN,
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
  describe('1. Authentication & Security Edge Cases', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const res = await request(app).get('/api/v1/admin/notifications');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 401 when token is invalid or unauthenticated', async () => {

      const res = await request(app)
        .get('/api/v1/admin/notifications')
        .set('Authorization', 'Bearer invalid_fcm_or_session');
      expect([401, 500]).toContain(res.status);
    });

    it('returns 403 when authenticated user is not an ADMIN (e.g. CUSTOMER)', async () => {
      const res = await request(app)
        .get('/api/v1/admin/notifications')
        .set('Authorization', `Bearer ${SESSIONS.customer}`);
      expect(res.status).toBe(403);
    });

    it('returns 401/403 when admin account is deactivated', async () => {
      const res = await request(app)
        .get('/api/v1/admin/notifications')
        .set('Authorization', `Bearer ${SESSIONS.deactivated}`);
      expect([401, 403]).toContain(res.status);
    });

    it('returns 403 when admin lacks required notifications permissions', async () => {
      const res = await request(app)
        .get('/api/v1/admin/notifications')
        .set('Authorization', `Bearer ${SESSIONS.noPerm}`);
      expect(res.status).toBe(403);
    });
  });

  // ── 2. RBAC Permissions ──────────────────────────────────────────────────────
  describe('2. RBAC Permissions Matrix', () => {
    it('allows GET /notifications with notifications.read', async () => {
      jest.spyOn(adminNotificationService, 'listNotifications').mockResolvedValueOnce({
        items: [],
        pagination: { total: 0, page: 1, limit: 20, totalPages: 1 },
      });

      const res = await request(app)
        .get('/api/v1/admin/notifications')
        .set('Authorization', `Bearer ${SESSIONS.readAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('denies POST /notifications/templates without notifications.manage', async () => {
      const res = await request(app)
        .post('/api/v1/admin/notifications/templates')
        .set('Authorization', `Bearer ${SESSIONS.readAdmin}`)
        .send({
          templateKey: 'test_template',
          title: 'Test',
          body: 'Body',
          notificationType: 'SYSTEM_ALERT',
        });

      expect(res.status).toBe(403);
    });

    it('allows POST /notifications/templates with notifications.manage', async () => {
      jest.spyOn(adminNotificationService, 'createTemplate').mockResolvedValueOnce({
        id: TEST_TEMPLATE_ID,
        templateKey: 'test_template',
        title: 'Test',
        body: 'Body',
        isActive: true,
      });

      const res = await request(app)
        .post('/api/v1/admin/notifications/templates')
        .set('Authorization', `Bearer ${SESSIONS.manageAdmin}`)
        .send({
          templateKey: 'test_template',
          title: 'Test',
          body: 'Body',
          notificationType: 'SYSTEM_ALERT',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    it('denies POST /notifications/send without notifications.send', async () => {
      const res = await request(app)
        .post('/api/v1/admin/notifications/send')
        .set('Authorization', `Bearer ${SESSIONS.manageAdmin}`)
        .send({
          recipientType: 'CUSTOMER',
          recipientId: TEST_CUSTOMER_ID,
          title: 'Direct Alert',
          body: 'Alert message',
        });

      expect(res.status).toBe(403);
    });

    it('allows POST /notifications/send with notifications.send', async () => {
      jest.spyOn(adminNotificationService, 'sendNotification').mockResolvedValueOnce({
        id: TEST_NOTIFICATION_ID,
        title: 'Direct Alert',
        status: 'SENT',
      });

      const res = await request(app)
        .post('/api/v1/admin/notifications/send')
        .set('Authorization', `Bearer ${SESSIONS.sendAdmin}`)
        .send({
          recipientType: 'CUSTOMER',
          recipientId: TEST_CUSTOMER_ID,
          title: 'Direct Alert',
          body: 'Alert message',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    it('SUPER_ADMIN can perform all notification actions bypassing granular permissions', async () => {
      jest.spyOn(adminNotificationService, 'listNotifications').mockResolvedValueOnce({
        items: [],
        pagination: { total: 0, page: 1, limit: 20, totalPages: 1 },
      });

      const res = await request(app)
        .get('/api/v1/admin/notifications')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);

      expect(res.status).toBe(200);
    });
  });

  // ── 3. Notification Listing & Visibility ─────────────────────────────────────
  describe('3. Notification Listing & Visibility (GET /api/v1/admin/notifications)', () => {
    it('returns paginated notifications and verifies NO device tokens or secrets exposed', async () => {
      jest.spyOn(adminNotificationService, 'listNotifications').mockResolvedValueOnce({
        items: [
          {
            id: TEST_NOTIFICATION_ID,
            title: 'Booking Confirmed',
            body: 'Your ride is booked.',
            channel: 'PUSH',
            status: 'SENT',
            recipient: {
              id: TEST_CUSTOMER_ID,
              type: 'CUSTOMER',
              name: 'John Customer',
            },
            sentAt: '2026-09-01T10:00:00Z',
            createdAt: '2026-09-01T09:59:00Z',
          },
        ],
        pagination: { total: 1, page: 1, limit: 20, totalPages: 1 },
      });

      const res = await request(app)
        .get('/api/v1/admin/notifications?search=Booking&status=SENT&channel=PUSH')
        .set('Authorization', `Bearer ${SESSIONS.readAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.meta.pagination.total).toBe(1);

      // Verify zero token leakage
      const rawText = JSON.stringify(res.body);
      expect(rawText).not.toContain('fcm_token');
      expect(rawText).not.toContain('device_token');
      expect(rawText).not.toContain('private_key');
      expect(rawText).not.toContain('client_email');
    });
  });

  // ── 4. Notification Detail & Status ──────────────────────────────────────────
  describe('4. Notification Detail & Delivery Status', () => {
    it('returns notification detail safely for valid ID', async () => {
      jest.spyOn(adminNotificationService, 'getNotificationById').mockResolvedValueOnce({
        id: TEST_NOTIFICATION_ID,
        title: 'Booking Confirmed',
        body: 'Details',
        channel: 'PUSH',
        status: 'DELIVERED',
        recipient: { id: TEST_CUSTOMER_ID, type: 'CUSTOMER' },
      });

      const res = await request(app)
        .get(`/api/v1/admin/notifications/${TEST_NOTIFICATION_ID}`)
        .set('Authorization', `Bearer ${SESSIONS.readAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(TEST_NOTIFICATION_ID);
    });

    it('returns 400 for malformed UUID (BOLA/IDOR protection)', async () => {
      const res = await request(app)
        .get('/api/v1/admin/notifications/not-a-valid-uuid')
        .set('Authorization', `Bearer ${SESSIONS.readAdmin}`);

      expect(res.status).toBe(400);
    });

    it('returns delivery status via /status endpoint', async () => {
      jest.spyOn(adminNotificationService, 'getNotificationStatus').mockResolvedValueOnce({
        id: TEST_NOTIFICATION_ID,
        status: 'DELIVERED',
        channel: 'PUSH',
        deliveredAt: '2026-09-01T10:00:05Z',
      });

      const res = await request(app)
        .get(`/api/v1/admin/notifications/${TEST_NOTIFICATION_ID}/status`)
        .set('Authorization', `Bearer ${SESSIONS.readAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('DELIVERED');
      expect(res.body.data.deliveredAt).toBe('2026-09-01T10:00:05Z');
    });
  });

  // ── 5. Notification Templates Management ─────────────────────────────────────
  describe('5. Notification Templates (CRUD & Activation)', () => {
    it('lists templates with pagination and filters', async () => {
      jest.spyOn(adminNotificationService, 'listTemplates').mockResolvedValueOnce({
        items: [{ id: TEST_TEMPLATE_ID, templateKey: 'welcome_customer' }],
        pagination: { total: 1, page: 1, limit: 20, totalPages: 1 },
      });

      const res = await request(app)
        .get('/api/v1/admin/notifications/templates')
        .set('Authorization', `Bearer ${SESSIONS.readAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it('creates a new template with validation', async () => {
      const templatePayload = {
        templateKey: 'trip_arrived',
        title: 'Your Ride Arrived',
        body: 'Vehicle {{vehicleNumber}} is outside.',
        notificationType: 'BOOKING_UPDATE',
        channel: 'PUSH',
        targetAudience: 'CUSTOMER',
        variables: ['vehicleNumber'],
      };

      jest.spyOn(adminNotificationService, 'createTemplate').mockResolvedValueOnce({
        id: TEST_TEMPLATE_ID,
        ...templatePayload,
        isActive: true,
      });

      const res = await request(app)
        .post('/api/v1/admin/notifications/templates')
        .set('Authorization', `Bearer ${SESSIONS.manageAdmin}`)
        .send(templatePayload);

      expect(res.status).toBe(201);
      expect(res.body.data.templateKey).toBe('trip_arrived');
    });

    it('rejects invalid template creation payload (missing title)', async () => {
      const res = await request(app)
        .post('/api/v1/admin/notifications/templates')
        .set('Authorization', `Bearer ${SESSIONS.manageAdmin}`)
        .send({
          templateKey: 'no_title',
          body: 'Missing title',
        });

      expect(res.status).toBe(400);
    });

    it('updates a template via PATCH', async () => {
      jest.spyOn(adminNotificationService, 'updateTemplate').mockResolvedValueOnce({
        id: TEST_TEMPLATE_ID,
        templateKey: 'trip_arrived',
        title: 'Updated Title',
        body: 'Updated Body',
      });

      const res = await request(app)
        .patch(`/api/v1/admin/notifications/templates/${TEST_TEMPLATE_ID}`)
        .set('Authorization', `Bearer ${SESSIONS.manageAdmin}`)
        .send({ title: 'Updated Title' });

      expect(res.status).toBe(200);
      expect(res.body.data.title).toBe('Updated Title');
    });

    it('activates a template via POST /activate', async () => {
      jest.spyOn(adminNotificationService, 'activateTemplate').mockResolvedValueOnce({
        id: TEST_TEMPLATE_ID,
        isActive: true,
      });

      const res = await request(app)
        .post(`/api/v1/admin/notifications/templates/${TEST_TEMPLATE_ID}/activate`)
        .set('Authorization', `Bearer ${SESSIONS.manageAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.isActive).toBe(true);
    });

    it('deactivates a template via POST /deactivate', async () => {
      jest.spyOn(adminNotificationService, 'deactivateTemplate').mockResolvedValueOnce({
        id: TEST_TEMPLATE_ID,
        isActive: false,
      });

      const res = await request(app)
        .post(`/api/v1/admin/notifications/templates/${TEST_TEMPLATE_ID}/deactivate`)
        .set('Authorization', `Bearer ${SESSIONS.manageAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.isActive).toBe(false);
    });
  });

  // ── 6. Admin-Triggered Send & Target Validation ──────────────────────────────
  describe('6. Admin-Triggered Send & Target Validation', () => {
    it('sends notification to CUSTOMER recipient safely', async () => {
      jest.spyOn(adminNotificationService, 'sendNotification').mockResolvedValueOnce({
        id: TEST_NOTIFICATION_ID,
        title: 'Welcome to Gongo',
        body: 'Enjoy your rides.',
        recipientType: 'CUSTOMER',
        channel: 'PUSH',
        status: 'SENT',
      });

      const res = await request(app)
        .post('/api/v1/admin/notifications/send')
        .set('Authorization', `Bearer ${SESSIONS.sendAdmin}`)
        .send({
          recipientType: 'CUSTOMER',
          recipientId: TEST_CUSTOMER_ID,
          title: 'Welcome to Gongo',
          body: 'Enjoy your rides.',
          channel: 'PUSH',
          notificationType: 'SYSTEM_ALERT',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('SENT');
      expect(res.body.data.recipientType).toBe('CUSTOMER');
    });

    it('sends notification to PARTNER recipient safely', async () => {
      jest.spyOn(adminNotificationService, 'sendNotification').mockResolvedValueOnce({
        id: TEST_NOTIFICATION_ID,
        title: 'Fleet Payout',
        body: 'Payout processed.',
        recipientType: 'PARTNER',
        channel: 'PUSH',
        status: 'SENT',
      });

      const res = await request(app)
        .post('/api/v1/admin/notifications/send')
        .set('Authorization', `Bearer ${SESSIONS.sendAdmin}`)
        .send({
          recipientType: 'PARTNER',
          recipientId: TEST_PARTNER_ID,
          title: 'Fleet Payout',
          body: 'Payout processed.',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.recipientType).toBe('PARTNER');
    });

    it('rejects booking ownership mismatch (BOLA/IDOR protection)', async () => {
      jest.spyOn(adminNotificationService, 'sendNotification').mockRejectedValueOnce(
        new ForbiddenError(`Booking '${TEST_BOOKING_ID}' does not belong to recipient '${TEST_CUSTOMER_ID}'`),
      );

      const res = await request(app)
        .post('/api/v1/admin/notifications/send')
        .set('Authorization', `Bearer ${SESSIONS.sendAdmin}`)
        .send({
          recipientType: 'CUSTOMER',
          recipientId: TEST_CUSTOMER_ID,
          bookingId: TEST_BOOKING_ID,
          title: 'Booking Alert',
          body: 'Update',
        });

      expect(res.status).toBe(403);
    });

    it('handles idempotent retries gracefully', async () => {
      jest.spyOn(adminNotificationService, 'sendNotification').mockResolvedValueOnce({
        id: TEST_NOTIFICATION_ID,
        title: 'Already Sent',
        status: 'SENT',
        eventKey: 'idemp-key-12345',
      });

      const res = await request(app)
        .post('/api/v1/admin/notifications/send')
        .set('Authorization', `Bearer ${SESSIONS.sendAdmin}`)
        .send({
          recipientType: 'CUSTOMER',
          recipientId: TEST_CUSTOMER_ID,
          title: 'Already Sent',
          body: 'Body',
          idempotencyKey: 'idemp-key-12345',
        });

      expect([200, 201]).toContain(res.status);
      expect(res.body.data.id).toBe(TEST_NOTIFICATION_ID);
    });

    it('retries failed notification delivery via POST /:id/send', async () => {
      jest.spyOn(adminNotificationService, 'retryNotification').mockResolvedValueOnce({
        id: TEST_NOTIFICATION_ID,
        status: 'SENT',
      });

      const res = await request(app)
        .post(`/api/v1/admin/notifications/${TEST_NOTIFICATION_ID}/send`)
        .set('Authorization', `Bearer ${SESSIONS.sendAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('SENT');
    });
  });
});
