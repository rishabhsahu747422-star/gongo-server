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
const adminDamageDisputeRepository = require('../../src/repositories/admin-damage-dispute.repository');
const adminPaymentRepository = require('../../src/repositories/admin-payment.repository');
const auditService = require('../../src/services/audit.service');
const s3Provider = require('../../src/providers/s3');
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

const OPERATIONS_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000002',
  auth_id: 'sup-operations-admin',
  role: 'ADMIN',
  name: 'Operations Admin',
  email: 'operations@gongo.in',
  is_active: true,
  permissions: [
    PERMISSIONS.DAMAGES_READ,
    PERMISSIONS.DAMAGES_UPDATE,
  ],
};

const SUPPORT_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000003',
  auth_id: 'sup-support-admin',
  role: 'ADMIN',
  name: 'Support Admin',
  email: 'support@gongo.in',
  is_active: true,
  permissions: [
    PERMISSIONS.DISPUTES_READ,
    PERMISSIONS.DISPUTES_RESOLVE,
    PERMISSIONS.DAMAGES_READ,
    PERMISSIONS.DAMAGES_UPDATE,
  ],
};

const READONLY_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000004',
  auth_id: 'sup-readonly-admin',
  role: 'ADMIN',
  name: 'Readonly Admin',
  email: 'readonly@gongo.in',
  is_active: true,
  permissions: [
    PERMISSIONS.DAMAGES_READ,
    PERMISSIONS.DISPUTES_READ,
  ],
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

const CUSTOMER_USER = {
  id: 'c0000001-0000-4000-c000-000000000001',
  auth_id: 'sup-customer',
  role: 'CUSTOMER',
  name: 'Regular Customer',
  email: 'customer@gongo.in',
  is_active: true,
  permissions: [],
};

const PARTNER_USER = {
  id: 'p0000001-0000-4000-p000-000000000001',
  auth_id: 'sup-partner',
  role: 'PARTNER',
  name: 'Fleet Partner',
  email: 'partner@gongo.in',
  is_active: true,
  permissions: [],
};

const SESSIONS = {
  superAdmin: 'sess_superadmin_dmg_token_001',
  operationsAdmin: 'sess_opsadmin_dmg_token_002',
  supportAdmin: 'sess_suppadmin_dmg_token_003',
  readonlyAdmin: 'sess_readonly_dmg_token_004',
  noPermAdmin: 'sess_noperm_dmg_token_005',
  deactivatedAdmin: 'sess_deactivated_dmg_token_006',
  customer: 'sess_customer_dmg_token_007',
  partner: 'sess_partner_dmg_token_008',
};

const TEST_DAMAGE_ID = 'a0000001-0000-4000-a000-000000000001';
const TEST_DISPUTE_ID = 'd0000001-0000-4000-a000-000000000001';
const TEST_BOOKING_ID = 'b0000001-0000-4000-a000-000000000001';
const TEST_VEHICLE_ID = 'e0000001-0000-4000-a000-000000000001';
const TEST_PARTNER_ID = 'f0000001-0000-4000-a000-000000000001';
const TEST_CUSTOMER_ID = 'c0000001-0000-4000-a000-000000000001';
const TEST_PAYMENT_ID = 'a0000003-0000-4000-a000-000000000001';

describe('Integration: Admin Damage & Dispute Management (Phase 14)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(auditService, 'logAdminAction').mockResolvedValue({});

    // Session resolution mock
    jest.spyOn(adminSessionRepository, 'findByToken').mockImplementation(async (tokenHash) => {
      const match = Object.entries(SESSIONS).find(
        ([, rawToken]) => hashSessionToken(rawToken) === tokenHash,
      );
      if (!match) return null;
      const key = match[0];
      const userMap = {
        superAdmin: SUPER_ADMIN_USER,
        operationsAdmin: OPERATIONS_ADMIN,
        supportAdmin: SUPPORT_ADMIN,
        readonlyAdmin: READONLY_ADMIN,
        noPermAdmin: NO_PERM_ADMIN,
        deactivatedAdmin: DEACTIVATED_ADMIN,
        customer: CUSTOMER_USER,
        partner: PARTNER_USER,
      };
      const user = userMap[key];
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

    // User lookup mock
    jest.spyOn(userRepository, 'findById').mockImplementation(async (id) => {
      const allUsers = [
        SUPER_ADMIN_USER,
        OPERATIONS_ADMIN,
        SUPPORT_ADMIN,
        READONLY_ADMIN,
        NO_PERM_ADMIN,
        DEACTIVATED_ADMIN,
        CUSTOMER_USER,
        PARTNER_USER,
      ];
      return allUsers.find((u) => u.id === id) || null;
    });

    // S3 mock
    jest.spyOn(s3Provider, 'createPresignedGetUrl').mockImplementation(async ({ key }) => ({
      downloadUrl: `https://gongo-s3.example.com/signed/${key}?sig=abc`,
      key,
      expiresInSeconds: 900,
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 1. AUTHENTICATION & ACCESS CONTROL
  // ══════════════════════════════════════════════════════════════════════════════

  describe('1. Authentication & RBAC', () => {
    it('rejects unauthenticated request with 401', async () => {
      const res = await request(app).get('/api/v1/admin/damages');
      expect(res.status).toBe(401);
    });

    it('rejects CUSTOMER session with 403', async () => {
      const res = await request(app)
        .get('/api/v1/admin/damages')
        .set('Authorization', `Bearer ${SESSIONS.customer}`);
      expect(res.status).toBe(403);
    });

    it('rejects PARTNER session with 403', async () => {
      const res = await request(app)
        .get('/api/v1/admin/damages')
        .set('Authorization', `Bearer ${SESSIONS.partner}`);
      expect(res.status).toBe(403);
    });

    it('rejects deactivated ADMIN session with 401 or 403', async () => {
      const res = await request(app)
        .get('/api/v1/admin/damages')
        .set('Authorization', `Bearer ${SESSIONS.deactivatedAdmin}`);
      expect([401, 403]).toContain(res.status);
    });

    it('rejects ADMIN without damages.read permission with 403', async () => {
      const res = await request(app)
        .get('/api/v1/admin/damages')
        .set('Authorization', `Bearer ${SESSIONS.noPermAdmin}`);
      expect(res.status).toBe(403);
    });

    it('rejects ADMIN without damages.update permission from mutating damage with 403', async () => {
      const res = await request(app)
        .post(`/api/v1/admin/damages/${TEST_DAMAGE_ID}/review`)
        .set('Authorization', `Bearer ${SESSIONS.readonlyAdmin}`)
        .send({});
      expect(res.status).toBe(403);
    });

    it('rejects ADMIN without disputes.resolve permission from resolving dispute with 403', async () => {
      const res = await request(app)
        .post(`/api/v1/admin/disputes/${TEST_DISPUTE_ID}/resolve`)
        .set('Authorization', `Bearer ${SESSIONS.readonlyAdmin}`)
        .send({
          resolution: 'Test resolution',
          resolutionReason: 'Test reason string',
        });
      expect(res.status).toBe(403);
    });

    it('allows SUPER_ADMIN to bypass all granular permission checks', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'listDamages').mockResolvedValueOnce({
        damages: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 1,
      });

      const res = await request(app)
        .get('/api/v1/admin/damages')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);
      expect(res.status).toBe(200);
    });

    it('ignores client-spoofed role headers', async () => {
      const res = await request(app)
        .get('/api/v1/admin/damages')
        .set('Authorization', `Bearer ${SESSIONS.noPermAdmin}`)
        .set('x-role', 'SUPER_ADMIN')
        .set('x-admin', 'true');
      expect(res.status).toBe(403);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 2. BOLA / IDOR PROTECTION
  // ══════════════════════════════════════════════════════════════════════════════

  describe('2. BOLA / IDOR Protection', () => {
    it('returns 400 for malformed damage UUID', async () => {
      const res = await request(app)
        .get('/api/v1/admin/damages/not-a-valid-uuid')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);
      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent damage ID', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDamageById').mockResolvedValueOnce(null);

      const res = await request(app)
        .get(`/api/v1/admin/damages/${TEST_DAMAGE_ID}`)
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);
      expect(res.status).toBe(404);
    });

    it('returns 400 for malformed dispute UUID', async () => {
      const res = await request(app)
        .get('/api/v1/admin/disputes/malformed-id-123')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);
      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent dispute ID', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDisputeById').mockResolvedValueOnce(null);

      const res = await request(app)
        .get(`/api/v1/admin/disputes/${TEST_DISPUTE_ID}`)
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);
      expect(res.status).toBe(404);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 3. DAMAGE MANAGEMENT ENDPOINTS
  // ══════════════════════════════════════════════════════════════════════════════

  describe('3. Damage Management Endpoints', () => {
    it('GET /api/v1/admin/damages returns paginated damages list with filters', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'listDamages').mockResolvedValueOnce({
        damages: [
          {
            id: TEST_DAMAGE_ID,
            bookingNumber: 'BK-1001',
            status: 'REPORTED',
            damageType: 'SCRATCH',
            estimatedAmount: 1200.00,
          },
        ],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });

      const res = await request(app)
        .get('/api/v1/admin/damages?status=REPORTED&limit=20')
        .set('Authorization', `Bearer ${SESSIONS.operationsAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.damages).toHaveLength(1);
      expect(res.body.data.damages[0].id).toBe(TEST_DAMAGE_ID);
    });

    it('GET /api/v1/admin/damages/:id returns full damage details with joined entities', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDamageById').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        booking: { id: TEST_BOOKING_ID, bookingNumber: 'BK-1001' },
        vehicle: { id: TEST_VEHICLE_ID, registrationNumber: 'KA-01-AB-1234' },
        partner: { id: TEST_PARTNER_ID, businessName: 'Metro Fleet' },
        customer: { id: TEST_CUSTOMER_ID, name: 'John Doe' },
        status: 'UNDER_REVIEW',
        damageType: 'DENT',
        estimatedAmount: 3000.00,
        approvedAmount: null,
      });

      const res = await request(app)
        .get(`/api/v1/admin/damages/${TEST_DAMAGE_ID}`)
        .set('Authorization', `Bearer ${SESSIONS.operationsAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.booking.bookingNumber).toBe('BK-1001');
      expect(res.body.data.vehicle.registrationNumber).toBe('KA-01-AB-1234');
      expect(res.body.data.partner.businessName).toBe('Metro Fleet');
      expect(res.body.data.customer.name).toBe('John Doe');
    });

    it('GET /api/v1/admin/damages/:id/evidence returns presigned URLs', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDamageById').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        bookingId: TEST_BOOKING_ID,
        photos: ['damages/rear_bumper.jpg'],
      });

      const res = await request(app)
        .get(`/api/v1/admin/damages/${TEST_DAMAGE_ID}/evidence`)
        .set('Authorization', `Bearer ${SESSIONS.operationsAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.photos).toHaveLength(1);
      expect(res.body.data.photos[0].downloadUrl).toContain('https://gongo-s3.example.com');
    });

    it('GET /api/v1/admin/damages/:id/booking returns associated booking details', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDamageById').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        booking: { id: TEST_BOOKING_ID, bookingNumber: 'BK-1001', status: 'ACTIVE' },
      });

      const res = await request(app)
        .get(`/api/v1/admin/damages/${TEST_DAMAGE_ID}/booking`)
        .set('Authorization', `Bearer ${SESSIONS.operationsAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.bookingNumber).toBe('BK-1001');
    });

    it('GET /api/v1/admin/damages/:id/inspections returns pickup and return verification data', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDamageById').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        bookingId: TEST_BOOKING_ID,
      });

      jest.spyOn(adminDamageDisputeRepository, 'getDamageInspections').mockResolvedValueOnce({
        pickup: { id: 'pk-1', odometerStart: 12000, photos: ['pk.jpg'] },
        return: { id: 'ret-1', odometerEnd: 12350, photos: ['ret.jpg'], lateMinutes: 15 },
      });

      const res = await request(app)
        .get(`/api/v1/admin/damages/${TEST_DAMAGE_ID}/inspections`)
        .set('Authorization', `Bearer ${SESSIONS.operationsAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.pickup.odometerStart).toBe(12000);
      expect(res.body.data.return.lateMinutes).toBe(15);
    });

    it('POST /api/v1/admin/damages/:id/review marks report under review', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'executeInTransaction').mockImplementation(
        async (cb) => cb({ query: jest.fn() }),
      );
      jest.spyOn(adminDamageDisputeRepository, 'getDamageForUpdate').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        status: 'REPORTED',
      });
      jest.spyOn(adminDamageDisputeRepository, 'updateDamageStatus').mockResolvedValueOnce({});
      jest.spyOn(adminDamageDisputeRepository, 'getDamageById').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        status: 'UNDER_REVIEW',
      });

      const res = await request(app)
        .post(`/api/v1/admin/damages/${TEST_DAMAGE_ID}/review`)
        .set('Authorization', `Bearer ${SESSIONS.operationsAdmin}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('UNDER_REVIEW');
    });

    it('POST /api/v1/admin/damages/:id/assess approves damage with amount', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'executeInTransaction').mockImplementation(
        async (cb) => cb({ query: jest.fn() }),
      );
      jest.spyOn(adminDamageDisputeRepository, 'getDamageForUpdate').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        status: 'UNDER_REVIEW',
      });
      jest.spyOn(adminDamageDisputeRepository, 'updateDamageStatus').mockResolvedValueOnce({});
      jest.spyOn(adminDamageDisputeRepository, 'getDamageById').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        status: 'APPROVED',
        approvedAmount: 1800.00,
      });

      const res = await request(app)
        .post(`/api/v1/admin/damages/${TEST_DAMAGE_ID}/assess`)
        .set('Authorization', `Bearer ${SESSIONS.operationsAdmin}`)
        .send({
          approvedAmount: 1800,
          reason: 'Workshop quote verified and approved',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('APPROVED');
      expect(res.body.data.approvedAmount).toBe(1800.00);
    });

    it('POST /api/v1/admin/damages/:id/reject rejects damage report', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'executeInTransaction').mockImplementation(
        async (cb) => cb({ query: jest.fn() }),
      );
      jest.spyOn(adminDamageDisputeRepository, 'getDamageForUpdate').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        status: 'REPORTED',
      });
      jest.spyOn(adminDamageDisputeRepository, 'updateDamageStatus').mockResolvedValueOnce({});
      jest.spyOn(adminDamageDisputeRepository, 'getDamageById').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        status: 'REJECTED',
      });

      const res = await request(app)
        .post(`/api/v1/admin/damages/${TEST_DAMAGE_ID}/reject`)
        .set('Authorization', `Bearer ${SESSIONS.operationsAdmin}`)
        .send({
          reason: 'Normal wear and tear; not customer fault',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('REJECTED');
    });

    it('POST /api/v1/admin/damages/:id/settle settles approved damage report', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'executeInTransaction').mockImplementation(
        async (cb) => cb({ query: jest.fn() }),
      );
      jest.spyOn(adminDamageDisputeRepository, 'getDamageForUpdate').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        status: 'APPROVED',
      });
      jest.spyOn(adminDamageDisputeRepository, 'updateDamageStatus').mockResolvedValueOnce({});
      jest.spyOn(adminDamageDisputeRepository, 'getDamageById').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        status: 'SETTLED',
      });

      const res = await request(app)
        .post(`/api/v1/admin/damages/${TEST_DAMAGE_ID}/settle`)
        .set('Authorization', `Bearer ${SESSIONS.operationsAdmin}`)
        .send({ notes: 'Insurance payment received' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('SETTLED');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 4. DISPUTE MANAGEMENT ENDPOINTS
  // ══════════════════════════════════════════════════════════════════════════════

  describe('4. Dispute Management Endpoints', () => {
    it('GET /api/v1/admin/disputes returns paginated disputes with filters', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'listDisputes').mockResolvedValueOnce({
        disputes: [
          {
            id: TEST_DISPUTE_ID,
            disputeNumber: 'DSP-2026-001',
            status: 'OPEN',
            priority: 'HIGH',
            disputedAmount: 2500.00,
          },
        ],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });

      const res = await request(app)
        .get('/api/v1/admin/disputes?status=OPEN')
        .set('Authorization', `Bearer ${SESSIONS.supportAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.disputes).toHaveLength(1);
      expect(res.body.data.disputes[0].disputeNumber).toBe('DSP-2026-001');
    });

    it('GET /api/v1/admin/disputes/:id returns dispute details', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDisputeById').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        disputeNumber: 'DSP-2026-001',
        booking: { id: TEST_BOOKING_ID, bookingNumber: 'BK-1001' },
        customer: { id: TEST_CUSTOMER_ID, name: 'Alice Customer' },
        partner: { id: TEST_PARTNER_ID, businessName: 'Metro Fleet' },
        status: 'UNDER_INVESTIGATION',
        disputedAmount: 2500.00,
      });

      const res = await request(app)
        .get(`/api/v1/admin/disputes/${TEST_DISPUTE_ID}`)
        .set('Authorization', `Bearer ${SESSIONS.supportAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.disputeNumber).toBe('DSP-2026-001');
      expect(res.body.data.customer.name).toBe('Alice Customer');
    });

    it('GET /api/v1/admin/disputes/:id/evidence returns presigned URLs', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDisputeById').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        disputeNumber: 'DSP-2026-001',
        evidence: ['disputes/invoice.pdf'],
      });

      const res = await request(app)
        .get(`/api/v1/admin/disputes/${TEST_DISPUTE_ID}/evidence`)
        .set('Authorization', `Bearer ${SESSIONS.supportAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.evidence).toHaveLength(1);
      expect(res.body.data.evidence[0].downloadUrl).toContain('https://gongo-s3.example.com');
    });

    it('GET /api/v1/admin/disputes/:id/timeline returns dispute timeline milestones', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDisputeById').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        disputeNumber: 'DSP-2026-001',
        status: 'OPEN',
        priority: 'MEDIUM',
        createdAt: new Date('2026-03-01T10:00:00Z'),
      });

      jest.spyOn(adminDamageDisputeRepository, 'getDisputeTimeline').mockResolvedValueOnce([]);

      const res = await request(app)
        .get(`/api/v1/admin/disputes/${TEST_DISPUTE_ID}/timeline`)
        .set('Authorization', `Bearer ${SESSIONS.supportAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.milestones).toHaveLength(1);
      expect(res.body.data.milestones[0].milestone).toBe('CREATED');
    });

    it('POST /api/v1/admin/disputes/:id/assign assigns dispute to admin user', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getActiveAdminUser').mockResolvedValueOnce({
        id: SUPPORT_ADMIN.id,
        role: 'ADMIN',
        is_active: true,
        name: 'Support Admin',
      });

      jest.spyOn(adminDamageDisputeRepository, 'executeInTransaction').mockImplementation(
        async (cb) => cb({ query: jest.fn() }),
      );

      jest.spyOn(adminDamageDisputeRepository, 'getDisputeForUpdate').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        status: 'OPEN',
      });
      jest.spyOn(adminDamageDisputeRepository, 'assignDispute').mockResolvedValueOnce({});
      jest.spyOn(adminDamageDisputeRepository, 'getDisputeById').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        status: 'UNDER_INVESTIGATION',
        assignedTo: SUPPORT_ADMIN.id,
      });

      const res = await request(app)
        .post(`/api/v1/admin/disputes/${TEST_DISPUTE_ID}/assign`)
        .set('Authorization', `Bearer ${SESSIONS.supportAdmin}`)
        .send({ adminUserId: SUPPORT_ADMIN.id, reason: 'Assigned for review' });

      expect(res.status).toBe(200);
      expect(res.body.data.assignedTo).toBe(SUPPORT_ADMIN.id);
    });

    it('POST /api/v1/admin/disputes/:id/resolve resolves dispute with resolution notes', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'executeInTransaction').mockImplementation(
        async (cb) => cb({ query: jest.fn() }),
      );

      jest.spyOn(adminDamageDisputeRepository, 'getDisputeForUpdate').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        status: 'UNDER_INVESTIGATION',
      });
      jest.spyOn(adminDamageDisputeRepository, 'updateDisputeStatus').mockResolvedValueOnce({});
      jest.spyOn(adminDamageDisputeRepository, 'getDisputeById').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        status: 'RESOLVED',
        resolution: 'Settled by mutual consent',
      });

      const res = await request(app)
        .post(`/api/v1/admin/disputes/${TEST_DISPUTE_ID}/resolve`)
        .set('Authorization', `Bearer ${SESSIONS.supportAdmin}`)
        .send({
          resolution: 'Settled by mutual consent',
          resolutionReason: 'Agreement reached with partner and customer',
          financialAction: 'NONE',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('RESOLVED');
    });

    it('POST /api/v1/admin/disputes/:id/reject rejects dispute with reason', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'executeInTransaction').mockImplementation(
        async (cb) => cb({ query: jest.fn() }),
      );

      jest.spyOn(adminDamageDisputeRepository, 'getDisputeForUpdate').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        status: 'OPEN',
      });
      jest.spyOn(adminDamageDisputeRepository, 'updateDisputeStatus').mockResolvedValueOnce({});
      jest.spyOn(adminDamageDisputeRepository, 'getDisputeById').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        status: 'REJECTED',
      });

      const res = await request(app)
        .post(`/api/v1/admin/disputes/${TEST_DISPUTE_ID}/reject`)
        .set('Authorization', `Bearer ${SESSIONS.supportAdmin}`)
        .send({
          rejectionReason: 'Invalid dispute claims with no proof',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('REJECTED');
    });

    it('POST /api/v1/admin/disputes creates a new dispute', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'createDispute').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
      });
      jest.spyOn(adminDamageDisputeRepository, 'getDisputeById').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        status: 'OPEN',
        disputeNumber: 'DSP-999',
      });

      const res = await request(app)
        .post('/api/v1/admin/disputes')
        .set('Authorization', `Bearer ${SESSIONS.supportAdmin}`)
        .send({
          bookingId: TEST_BOOKING_ID,
          customerId: TEST_CUSTOMER_ID,
          partnerId: TEST_PARTNER_ID,
          claimantId: TEST_CUSTOMER_ID,
          description: 'Billing discrepancy on extra hours',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.disputeNumber).toBe('DSP-999');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 5. CONCURRENCY & TERMINAL STATE HARDENING
  // ══════════════════════════════════════════════════════════════════════════════

  describe('5. Concurrency & Terminal State Hardening', () => {
    it('prevents double resolution of dispute returning 409 Conflict', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'executeInTransaction').mockImplementation(
        async (cb) => cb({ query: jest.fn() }),
      );

      jest.spyOn(adminDamageDisputeRepository, 'getDisputeForUpdate').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        status: 'RESOLVED',
      });

      const res = await request(app)
        .post(`/api/v1/admin/disputes/${TEST_DISPUTE_ID}/resolve`)
        .set('Authorization', `Bearer ${SESSIONS.supportAdmin}`)
        .send({
          resolution: 'Second resolution attempt',
          resolutionReason: 'Reason text is valid length',
        });

      expect(res.status).toBe(409);
    });

    it('prevents double assessment of damage returning 409 Conflict', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'executeInTransaction').mockImplementation(
        async (cb) => cb({ query: jest.fn() }),
      );

      jest.spyOn(adminDamageDisputeRepository, 'getDamageForUpdate').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        status: 'APPROVED',
      });

      const res = await request(app)
        .post(`/api/v1/admin/damages/${TEST_DAMAGE_ID}/assess`)
        .set('Authorization', `Bearer ${SESSIONS.operationsAdmin}`)
        .send({
          approvedAmount: 1500,
        });

      expect(res.status).toBe(409);
    });

    it('prevents resolving dispute with customer refund if refund exceeds refundable balance', async () => {
      const mockTxClient = {
        query: jest.fn().mockResolvedValueOnce({
          rows: [{ id: TEST_PAYMENT_ID, amount: '1000.00' }],
          rowCount: 1,
        }),
      };
      jest.spyOn(adminDamageDisputeRepository, 'executeInTransaction').mockImplementation(
        async (cb) => cb(mockTxClient),
      );

      jest.spyOn(adminDamageDisputeRepository, 'getDisputeForUpdate').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        status: 'UNDER_INVESTIGATION',
        booking_id: TEST_BOOKING_ID,
        customer_id: TEST_CUSTOMER_ID,
      });

      jest.spyOn(adminPaymentRepository, 'getPaymentRefundsSummary').mockResolvedValueOnce({
        completedRefundAmount: 800.00,
        pendingRefundAmount: 0.00,
      });

      const res = await request(app)
        .post(`/api/v1/admin/disputes/${TEST_DISPUTE_ID}/resolve`)
        .set('Authorization', `Bearer ${SESSIONS.supportAdmin}`)
        .send({
          resolution: 'Attempting refund higher than remaining',
          resolutionReason: 'Excess refund amount requested',
          settledAmount: 500.00, // Remaining is only 200
          financialAction: 'REFUND_CUSTOMER',
        });

      expect(res.status).toBe(400);
    });
  });
});
