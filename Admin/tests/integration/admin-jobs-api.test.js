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
const adminOutboxRepository = require('../../src/repositories/admin-outbox.repository');
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

const AUDIT_READ_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000002',
  auth_id: 'sup-audit-read-admin',
  role: 'ADMIN',
  name: 'Audit Read Admin',
  email: 'auditread@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.AUDIT_READ],
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

const NON_ADMIN_CUSTOMER = {
  id: 'c0000001-0000-4000-a000-000000000001',
  auth_id: 'sup-customer-user',
  role: 'CUSTOMER',
  name: 'Customer User',
  email: 'customer@gmail.com',
  is_active: true,
  permissions: [],
};

const SESSIONS = {
  superAdmin: 'sess_superadmin_jobs_token_001',
  auditRead: 'sess_auditread_jobs_token_002',
  noPerm: 'sess_noperm_jobs_token_004',
  customer: 'sess_customer_jobs_token_006',
};

describe('Phase 20 Integration: Admin Background Jobs & Reliability API', () => {
  beforeEach(() => {
    jest.spyOn(adminSessionRepository, 'findByToken').mockImplementation(async (tokenHash) => {
      const match = Object.entries(SESSIONS).find(
        ([, rawToken]) => hashSessionToken(rawToken) === tokenHash,
      );
      if (!match) return null;

      const [key] = match;
      let user = null;
      if (key === 'superAdmin') user = SUPER_ADMIN_USER;
      else if (key === 'auditRead') user = AUDIT_READ_ADMIN;
      else if (key === 'noPerm') user = NO_PERM_ADMIN;
      else if (key === 'customer') user = NON_ADMIN_CUSTOMER;

      if (!user) return null;

      return {
        id: `sess-${user.id}`,
        user_id: user.id,
        is_active: user.is_active,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      };
    });

    jest.spyOn(userRepository, 'findById').mockImplementation(async (id) => {
      if (id === SUPER_ADMIN_USER.id) return SUPER_ADMIN_USER;
      if (id === AUDIT_READ_ADMIN.id) return AUDIT_READ_ADMIN;
      if (id === NO_PERM_ADMIN.id) return NO_PERM_ADMIN;
      if (id === NON_ADMIN_CUSTOMER.id) return NON_ADMIN_CUSTOMER;
      return null;
    });

    jest.spyOn(adminSessionRepository, 'touchSession').mockResolvedValue(true);
    jest.spyOn(auditService, 'logAdminAction').mockResolvedValue({ id: 'action-1' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('1. GET /health/worker (Unauthenticated Operational Probe)', () => {
    it('returns worker operational status without authentication requirement', async () => {
      const res = await request(app).get('/health/worker');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('status');
      expect(res.body.data).toHaveProperty('workerId');
      expect(res.body.data).toHaveProperty('uptimeSeconds');
      expect(res.body.data).toHaveProperty('metrics');
    });
  });

  describe('2. GET /api/v1/admin/jobs/overview (RBAC & Visibility)', () => {
    it('rejects unauthenticated request with 401', async () => {
      const res = await request(app).get('/api/v1/admin/jobs/overview');
      expect(res.status).toBe(401);
    });

    it('rejects non-admin role with 403', async () => {
      const res = await request(app)
        .get('/api/v1/admin/jobs/overview')
        .set('Authorization', `Bearer ${SESSIONS.customer}`);
      expect(res.status).toBe(403);
    });

    it('rejects admin lacking required reliability permission with 403', async () => {
      const res = await request(app)
        .get('/api/v1/admin/jobs/overview')
        .set('Authorization', `Bearer ${SESSIONS.noPerm}`);
      expect(res.status).toBe(403);
    });

    it('allows super admin to view operational queue overview', async () => {
      jest.spyOn(adminOutboxRepository, 'getQueueStats').mockResolvedValue({
        pendingCount: 12,
        processingCount: 2,
        staleCount: 0,
        processedCount: 500,
        deadLetterCount: 1,
      });

      const res = await request(app)
        .get('/api/v1/admin/jobs/overview')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.queue.pendingCount).toBe(12);
      expect(res.body.data.queue.processedCount).toBe(500);
      expect(res.body.data.worker).toHaveProperty('workerId');
    });

    it('allows AUDIT_READ admin to view operational queue overview', async () => {
      jest.spyOn(adminOutboxRepository, 'getQueueStats').mockResolvedValue({
        pendingCount: 0,
        processingCount: 0,
        staleCount: 0,
        processedCount: 10,
        deadLetterCount: 0,
      });

      const res = await request(app)
        .get('/api/v1/admin/jobs/overview')
        .set('Authorization', `Bearer ${SESSIONS.auditRead}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('3. GET /api/v1/admin/jobs/events (Operational Event Listing)', () => {
    it('rejects invalid job status filter with 400 validation error', async () => {
      const res = await request(app)
        .get('/api/v1/admin/jobs/events?status=INVALID_STATUS')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/Invalid job status/i);
    });

    it('lists operational events with sanitized information', async () => {
      jest.spyOn(adminOutboxRepository, 'listOperationalEvents').mockResolvedValueOnce([
        {
          id: 'evt-1',
          eventType: 'NOTIFICATION_DISPATCH_REQUESTED',
          status: 'PROCESSED',
          retryCount: 0,
          maxRetries: 5,
        },
      ]);

      const res = await request(app)
        .get('/api/v1/admin/jobs/events?status=PROCESSED')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.count).toBe(1);
      expect(res.body.data.items[0].eventType).toBe('NOTIFICATION_DISPATCH_REQUESTED');
    });
  });

  describe('4. POST /api/v1/admin/jobs/reconcile & /cleanup (On-Demand Operations)', () => {
    it('enqueues on-demand reconciliation and records audit action', async () => {
      jest.spyOn(adminOutboxRepository, 'createEvent').mockResolvedValueOnce({
        id: 'outbox-rec-1',
        status: 'PENDING',
      });

      const res = await request(app)
        .post('/api/v1/admin/jobs/reconcile')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`)
        .send({ reason: 'Audit investigation' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.eventId).toBe('outbox-rec-1');
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'TRIGGER_RECONCILIATION',
          targetResource: 'SYSTEM',
        }),
      );
    });

    it('enqueues on-demand cleanup and records audit action', async () => {
      jest.spyOn(adminOutboxRepository, 'createEvent').mockResolvedValueOnce({
        id: 'outbox-clean-1',
        status: 'PENDING',
      });

      const res = await request(app)
        .post('/api/v1/admin/jobs/cleanup')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`)
        .send({ retentionDays: 14 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.eventId).toBe('outbox-clean-1');
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'TRIGGER_CLEANUP',
          targetResource: 'SYSTEM',
        }),
      );
    });
  });
});
