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
const adminVerificationRepository = require('../../src/repositories/admin-verification.repository');
const adminActionRepository = require('../../src/repositories/admin-action.repository');
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

const VERIFICATION_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000002',
  auth_id: 'sup-verif-admin',
  role: 'ADMIN',
  name: 'Verification Admin',
  email: 'verifadmin@gongo.in',
  is_active: true,
  permissions: [
    PERMISSIONS.KYC_READ,
    PERMISSIONS.KYC_VERIFY,
    PERMISSIONS.KYC_REJECT,
    PERMISSIONS.PARTNERS_READ,
    PERMISSIONS.PARTNERS_VERIFY,
    PERMISSIONS.VEHICLES_READ,
    PERMISSIONS.VEHICLES_VERIFY,
  ],
};

const READ_ONLY_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000003',
  auth_id: 'sup-read-admin',
  role: 'ADMIN',
  name: 'Read Only Admin',
  email: 'readonly@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.KYC_READ],
};

const UNAUTHORIZED_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000004',
  auth_id: 'sup-unauth-admin',
  role: 'ADMIN',
  name: 'No Verification Admin',
  email: 'noverif@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.CUSTOMERS_READ],
};

const DEACTIVATED_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000005',
  auth_id: 'sup-deactivated-admin',
  role: 'ADMIN',
  name: 'Deactivated Admin',
  email: 'deactivated@gongo.in',
  is_active: false,
  permissions: [PERMISSIONS.KYC_READ],
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

const TEST_PARTNER_ID = 'b1111111-1111-4111-a111-111111111111';
const TEST_VEHICLE_ID = 'd1111111-1111-4111-a111-111111111111';
const TEST_DOC_ID = 'e1111111-1111-4111-a111-111111111111';

const mockPartnerRecord = {
  id: TEST_PARTNER_ID,
  userId: 'u-1',
  businessName: 'Apex Mobility',
  businessType: 'CAR_RENTAL',
  city: 'Bengaluru',
  kycStatus: 'PENDING',
  isActive: true,
  owner: { name: 'Suresh Patel', email: 'suresh@apex.in', phone: '9876543210' },
  documents: [
    {
      id: TEST_DOC_ID,
      partnerId: TEST_PARTNER_ID,
      documentType: 'GST',
      documentNumber: '29ABCDE1234F1Z5',
      storageKey: 'partners/docs/gst.pdf',
      verificationStatus: 'PENDING',
    },
  ],
};

const mockVehicleRecord = {
  id: TEST_VEHICLE_ID,
  partnerId: TEST_PARTNER_ID,
  registrationNumber: 'KA-01-MJ-9999',
  brand: 'Tata',
  model: 'Nexon EV',
  verificationStatus: 'PENDING',
  isArchived: false,
  partner: { businessName: 'Apex Mobility' },
  documents: [],
  images: [],
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

describe('Integration: Admin KYC & Document Verification (Phase 11)', () => {
  let superAdminToken;
  let verifAdminToken;
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
        VERIFICATION_ADMIN,
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
          VERIFICATION_ADMIN,
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
    verifAdminToken = createMockSession(VERIFICATION_ADMIN);
    readOnlyAdminToken = createMockSession(READ_ONLY_ADMIN);
    unauthorizedAdminToken = createMockSession(UNAUTHORIZED_ADMIN);
    deactivatedAdminToken = createMockSession(DEACTIVATED_ADMIN);
    customerToken = createMockSession(CUSTOMER_USER);
    partnerToken = createMockSession(PARTNER_USER);

    // Default repository mocks
    jest.spyOn(adminVerificationRepository, 'withTransaction')
      .mockImplementation(async (cb) => cb({}));
    jest.spyOn(adminVerificationRepository, 'listPartnerVerifications').mockResolvedValue({
      partners: [mockPartnerRecord],
      total: 1,
    });
    jest.spyOn(adminVerificationRepository, 'findPartnerVerificationById')
      .mockImplementation(async (id) => {
        if (id === TEST_PARTNER_ID) return { ...mockPartnerRecord };
        return null;
      });
    jest.spyOn(adminVerificationRepository, 'findPartnerByIdForUpdate')
      .mockImplementation(async (id) => {
        if (id === TEST_PARTNER_ID) return { ...mockPartnerRecord };
        return null;
      });
    jest.spyOn(adminVerificationRepository, 'updatePartnerKycStatus')
      .mockImplementation(async (id, kycStatus) => ({
        ...mockPartnerRecord,
        kycStatus,
      }));

    jest.spyOn(adminVerificationRepository, 'listVehicleVerifications').mockResolvedValue({
      vehicles: [mockVehicleRecord],
      total: 1,
    });
    jest.spyOn(adminVerificationRepository, 'findVehicleVerificationById')
      .mockImplementation(async (id) => {
        if (id === TEST_VEHICLE_ID) return { ...mockVehicleRecord };
        return null;
      });
    jest.spyOn(adminVerificationRepository, 'findVehicleByIdForUpdate')
      .mockImplementation(async (id) => {
        if (id === TEST_VEHICLE_ID) return { ...mockVehicleRecord };
        return null;
      });
    jest.spyOn(adminVerificationRepository, 'updateVehicleVerificationStatus')
      .mockImplementation(async (id, verificationStatus) => ({
        ...mockVehicleRecord,
        verificationStatus,
      }));

    jest.spyOn(adminVerificationRepository, 'findDocumentById')
      .mockImplementation(async (id) => {
        if (id === TEST_DOC_ID) {
          return {
            entityType: 'PARTNER',
            document: {
              id: TEST_DOC_ID,
              entityId: TEST_PARTNER_ID,
              documentType: 'GST',
              documentNumber: '29ABCDE1234F1Z5',
              storageKey: 'partners/docs/gst.pdf',
              verificationStatus: 'PENDING',
            },
          };
        }
        return null;
      });
    jest.spyOn(adminVerificationRepository, 'findPartnerDocumentByIdForUpdate')
      .mockResolvedValue({
        id: TEST_DOC_ID,
        partnerId: TEST_PARTNER_ID,
        verificationStatus: 'PENDING',
        documentType: 'GST',
      });
    jest.spyOn(adminVerificationRepository, 'updatePartnerDocumentStatus')
      .mockResolvedValue({
        id: TEST_DOC_ID,
        verificationStatus: 'VERIFIED',
      });

    jest.spyOn(adminVerificationRepository, 'listKycVerifications').mockResolvedValue({
      items: [
        { entityId: TEST_PARTNER_ID, entityType: 'PARTNER', status: 'PENDING' },
        { entityId: TEST_VEHICLE_ID, entityType: 'VEHICLE', status: 'PENDING' },
      ],
      total: 2,
    });

    jest.spyOn(s3Provider, 'createPresignedGetUrl').mockResolvedValue({
      downloadUrl: 'https://gongo-s3.amazonaws.com/partners/docs/gst.pdf?signed=true',
      key: 'partners/docs/gst.pdf',
      expiresInSeconds: 900,
    });

    jest.spyOn(adminActionRepository, 'createAction').mockResolvedValue({ id: 'act-1' });
    jest.spyOn(auditService, 'logAdminAction').mockImplementation((evt) => evt);
  });

  // ── Authentication & RBAC Tests ─────────────────────────────────────────────

  describe('Authentication & Role Guards', () => {
    it('returns 401 Unauthorized when Authorization header is missing', async () => {
      const res = await request(app).get('/api/v1/admin/verifications/partners');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 403 Forbidden when Customer token is provided', async () => {
      const res = await request(app)
        .get('/api/v1/admin/verifications/partners')
        .set('Authorization', `Bearer ${customerToken}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('returns 403 Forbidden when Partner token is provided', async () => {
      const res = await request(app)
        .get('/api/v1/admin/verifications/partners')
        .set('Authorization', `Bearer ${partnerToken}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('returns 401 Unauthorized when Admin account is deactivated', async () => {
      const res = await request(app)
        .get('/api/v1/admin/verifications/partners')
        .set('Authorization', `Bearer ${deactivatedAdminToken}`);
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 403 Forbidden when Admin lacks kyc.read permission', async () => {
      const res = await request(app)
        .get('/api/v1/admin/verifications/kyc')
        .set('Authorization', `Bearer ${unauthorizedAdminToken}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('returns 200 OK for Admin with kyc.read permission', async () => {
      const res = await request(app)
        .get('/api/v1/admin/verifications/kyc')
        .set('Authorization', `Bearer ${readOnlyAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(2);
    });

    it('returns 200 OK for SUPER_ADMIN bypass', async () => {
      const res = await request(app)
        .get('/api/v1/admin/verifications/kyc')
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ── Anti-Spoofing & BOLA / IDOR Tests ───────────────────────────────────────

  describe('Anti-Spoofing & BOLA / IDOR Guards', () => {
    it('ignores client spoofing headers (x-admin, x-role, partnerId)', async () => {
      const res = await request(app)
        .get('/api/v1/admin/verifications/partners')
        .set('Authorization', `Bearer ${verifAdminToken}`)
        .set('x-admin', 'true')
        .set('x-role', 'SUPER_ADMIN')
        .set('partnerId', 'b9999999-9999-4999-a999-999999999999');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 400 Bad Request when partner ID is not a valid UUID', async () => {
      const res = await request(app)
        .get('/api/v1/admin/verifications/partners/not-a-valid-uuid')
        .set('Authorization', `Bearer ${verifAdminToken}`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('Invalid partnerId');
    });

    it('returns 404 Not Found when partner verification record does not exist', async () => {
      const nonExistentId = 'f9999999-9999-4999-a999-999999999999';
      const res = await request(app)
        .get(`/api/v1/admin/verifications/partners/${nonExistentId}`)
        .set('Authorization', `Bearer ${verifAdminToken}`);
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  // ── Partner Verification Tests ──────────────────────────────────────────────

  describe('Partner Verification Endpoints', () => {
    it('GET /verifications/partners lists partners with verification status', async () => {
      const res = await request(app)
        .get('/api/v1/admin/verifications/partners')
        .query({ search: 'Apex', kycStatus: 'PENDING', limit: 10 })
        .set('Authorization', `Bearer ${verifAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.partners).toHaveLength(1);
      expect(res.body.data.pagination.total).toBe(1);
    });

    it('GET /verifications/partners/:id returns partner details with documents', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/verifications/partners/${TEST_PARTNER_ID}`)
        .set('Authorization', `Bearer ${verifAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.businessName).toBe('Apex Mobility');
      expect(res.body.data.documents).toHaveLength(1);
    });

    it('POST /verifications/partners/:id/approve approves partner KYC', async () => {
      const res = await request(app)
        .post(`/api/v1/admin/verifications/partners/${TEST_PARTNER_ID}/approve`)
        .set('Authorization', `Bearer ${verifAdminToken}`)
        .send({ reason: 'All documents in order' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.kycStatus).toBe('VERIFIED');
      expect(adminActionRepository.createAction).toHaveBeenCalled();
    });

    it('POST /verifications/partners/:id/reject rejects partner KYC with mandatory reason', async () => {
      const res = await request(app)
        .post(`/api/v1/admin/verifications/partners/${TEST_PARTNER_ID}/reject`)
        .set('Authorization', `Bearer ${verifAdminToken}`)
        .send({ reason: 'Invalid business license' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.kycStatus).toBe('REJECTED');
      expect(adminActionRepository.createAction).toHaveBeenCalled();
    });
  });

  // ── Vehicle Verification Tests ──────────────────────────────────────────────

  describe('Vehicle Verification Endpoints', () => {
    it('GET /verifications/vehicles lists vehicles with verification status', async () => {
      const res = await request(app)
        .get('/api/v1/admin/verifications/vehicles')
        .query({ verificationStatus: 'PENDING', limit: 10 })
        .set('Authorization', `Bearer ${verifAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.vehicles).toHaveLength(1);
    });

    it('GET /verifications/vehicles/:id returns vehicle verification details', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/verifications/vehicles/${TEST_VEHICLE_ID}`)
        .set('Authorization', `Bearer ${verifAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.registrationNumber).toBe('KA-01-MJ-9999');
    });

    it('POST /verifications/vehicles/:id/approve approves vehicle verification', async () => {
      const res = await request(app)
        .post(`/api/v1/admin/verifications/vehicles/${TEST_VEHICLE_ID}/approve`)
        .set('Authorization', `Bearer ${verifAdminToken}`)
        .send({ reason: 'RC verified' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.verificationStatus).toBe('VERIFIED');
    });

    it('POST /verifications/vehicles/:id/reject rejects vehicle verification', async () => {
      const res = await request(app)
        .post(`/api/v1/admin/verifications/vehicles/${TEST_VEHICLE_ID}/reject`)
        .set('Authorization', `Bearer ${verifAdminToken}`)
        .send({ reason: 'Commercial insurance missing' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.verificationStatus).toBe('REJECTED');
    });
  });

  // ── Document Review & S3 Signed URL Tests ───────────────────────────────────

  describe('Document Verification & S3 Presigned URL Endpoints', () => {
    it('GET /verifications/documents/:id returns document metadata', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/verifications/documents/${TEST_DOC_ID}`)
        .set('Authorization', `Bearer ${verifAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.entityType).toBe('PARTNER');
      expect(res.body.data.document.documentType).toBe('GST');
    });

    it('GET /verifications/documents/:id/url generates short-lived presigned URL', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/verifications/documents/${TEST_DOC_ID}/url`)
        .set('Authorization', `Bearer ${verifAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.downloadUrl).toContain('amazonaws.com');
      expect(res.body.data.expiresInSeconds).toBe(900);
      expect(s3Provider.createPresignedGetUrl).toHaveBeenCalled();
    });

    it('POST /verifications/documents/:id/approve approves document', async () => {
      const res = await request(app)
        .post(`/api/v1/admin/verifications/documents/${TEST_DOC_ID}/approve`)
        .set('Authorization', `Bearer ${verifAdminToken}`)
        .send({ reason: 'Clear scan verified' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.verificationStatus).toBe('VERIFIED');
    });

    it('POST /verifications/documents/:id/reject rejects document with reason', async () => {
      jest.spyOn(adminVerificationRepository, 'updatePartnerDocumentStatus')
        .mockResolvedValue({
          id: TEST_DOC_ID,
          verificationStatus: 'REJECTED',
          rejectionReason: 'Document expired',
        });

      const res = await request(app)
        .post(`/api/v1/admin/verifications/documents/${TEST_DOC_ID}/reject`)
        .set('Authorization', `Bearer ${verifAdminToken}`)
        .send({ reason: 'Document expired' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.verificationStatus).toBe('REJECTED');
    });
  });

  // ── Unified KYC Queue & Backward Compatibility Tests ────────────────────────

  describe('Unified KYC Queue & Alias Endpoints', () => {
    it('GET /verifications/kyc returns unified queue', async () => {
      const res = await request(app)
        .get('/api/v1/admin/verifications/kyc')
        .set('Authorization', `Bearer ${verifAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(2);
    });

    it('GET /verification/partners works through backward-compatible alias route', async () => {
      const res = await request(app)
        .get('/api/v1/admin/verification/partners')
        .set('Authorization', `Bearer ${verifAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.partners).toHaveLength(1);
    });
  });
});
