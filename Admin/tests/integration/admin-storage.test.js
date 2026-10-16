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
const adminStorageRepository = require('../../src/repositories/admin-storage.repository');
const s3Provider = require('../../src/providers/s3');
const { hashSessionToken } = require('../../src/utils/crypto');
const { PERMISSIONS } = require('../../src/constants/permissions');
const { UnauthorizedError } = require('../../src/errors');
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

const STORAGE_READ_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000002',
  auth_id: 'sup-storage-read-admin',
  role: 'ADMIN',
  name: 'Storage Read Admin',
  email: 'storageread@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.STORAGE_READ],
};

const STORAGE_ACCESS_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000003',
  auth_id: 'sup-storage-access-admin',
  role: 'ADMIN',
  name: 'Storage Access Admin',
  email: 'storageaccess@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.STORAGE_DOCUMENTS_ACCESS],
};

const KYC_READ_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000004',
  auth_id: 'sup-kyc-read-admin',
  role: 'ADMIN',
  name: 'KYC Read Admin',
  email: 'kycread@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.KYC_READ],
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

const TEST_DOC_ID = 'da000001-0000-4000-a000-000000000001';
const TEST_PARTNER_ID = 'ba000001-0000-4000-a000-000000000001';
const TEST_VEHICLE_ID = 'ea000001-0000-4000-a000-000000000001';
const TEST_CUSTOMER_ID = 'ca000001-0000-4000-a000-000000000001';

const SESSIONS = {
  superAdmin: 'sess_superadmin_storage_token_001',
  storageRead: 'sess_storageread_storage_token_002',
  storageAccess: 'sess_storageaccess_storage_token_003',
  kycRead: 'sess_kycread_storage_token_004',
  noPerm: 'sess_noperm_storage_token_005',
  deactivated: 'sess_deactivated_storage_token_006',
  customer: 'sess_customer_storage_token_007',
};

describe('Integration: Admin Storage & Document Operations (Phase 18)', () => {
  beforeEach(() => {
    jest.spyOn(adminSessionRepository, 'findByToken').mockImplementation(async (tokenHash) => {
      const match = Object.entries(SESSIONS).find(
        ([, rawToken]) => hashSessionToken(rawToken) === tokenHash,
      );
      if (!match) return null;
      const key = match[0];
      const userMap = {
        superAdmin: SUPER_ADMIN_USER,
        storageRead: STORAGE_READ_ADMIN,
        storageAccess: STORAGE_ACCESS_ADMIN,
        kycRead: KYC_READ_ADMIN,
        noPerm: NO_PERM_ADMIN,
        deactivated: DEACTIVATED_ADMIN,
        customer: NON_ADMIN_CUSTOMER,
      };
      const user = userMap[key];
      if (!user) return null;

      return {
        id: `sess-${key}-id`,
        user_id: user.id,
        is_active: true,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        last_active_at: new Date().toISOString(),
      };
    });

    jest.spyOn(userRepository, 'findById').mockImplementation(async (userId) => {
      const users = [
        SUPER_ADMIN_USER,
        STORAGE_READ_ADMIN,
        STORAGE_ACCESS_ADMIN,
        KYC_READ_ADMIN,
        NO_PERM_ADMIN,
        DEACTIVATED_ADMIN,
        NON_ADMIN_CUSTOMER,
      ];
      return users.find((u) => u.id === userId) || null;
    });

    adminStorageRepository.query = jest.fn();
    adminStorageRepository.constructor.resetMockStorageResolver();


    // Default mock S3 behavior
    s3Provider.setMockPresigner(jest.fn().mockResolvedValue(
      'https://s3.amazonaws.com/gongo-admin-documents/docs/test.pdf?signature=test-sig-123',
    ));
    s3Provider.setMockS3Client({
      send: jest.fn().mockResolvedValue({
        ContentLength: 4096,
        ContentType: 'application/pdf',
        LastModified: new Date('2026-09-01'),
        ETag: '"etag-123"',
      }),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    adminStorageRepository.constructor.resetMockStorageResolver();
    s3Provider.resetS3Client();
  });

  // ── 1. Authentication & RBAC Guard Tests ────────────────────────────────────

  describe('1. Authentication & RBAC Access Control', () => {
    it('returns 401 when no session token is provided', async () => {
      const res = await request(app).get('/api/v1/admin/storage/documents');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 401 when invalid session token is provided', async () => {
      const res = await request(app)
        .get('/api/v1/admin/storage/documents')
        .set('Authorization', 'Bearer invalid-token-xyz');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 403 when admin user is deactivated', async () => {
      const res = await request(app)
        .get('/api/v1/admin/storage/documents')
        .set('Authorization', `Bearer ${SESSIONS.deactivated}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('returns 403 when user is not an ADMIN role (e.g. CUSTOMER)', async () => {
      const res = await request(app)
        .get('/api/v1/admin/storage/documents')
        .set('Authorization', `Bearer ${SESSIONS.customer}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('returns 403 when admin lacks storage permissions', async () => {
      const res = await request(app)
        .get('/api/v1/admin/storage/documents')
        .set('Authorization', `Bearer ${SESSIONS.noPerm}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('returns 200 when admin has storage.read permission', async () => {
      adminStorageRepository.query
        .mockResolvedValueOnce({ rows: [{ total: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get('/api/v1/admin/storage/documents')
        .set('Authorization', `Bearer ${SESSIONS.storageRead}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 200 when admin has storage.document.access permission', async () => {
      adminStorageRepository.query
        .mockResolvedValueOnce({ rows: [{ total: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get('/api/v1/admin/storage/documents')
        .set('Authorization', `Bearer ${SESSIONS.storageAccess}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 200 when admin has kyc.read permission', async () => {
      adminStorageRepository.query
        .mockResolvedValueOnce({ rows: [{ total: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get('/api/v1/admin/storage/documents')
        .set('Authorization', `Bearer ${SESSIONS.kycRead}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 200 when admin is SUPER_ADMIN (permission bypass)', async () => {
      adminStorageRepository.query
        .mockResolvedValueOnce({ rows: [{ total: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get('/api/v1/admin/storage/documents')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ── 2. Document Listing ─────────────────────────────────────────────────────

  describe('2. GET /api/v1/admin/storage/documents', () => {
    it('returns paginated documents list with search and filters', async () => {
      const mockDoc = {
        id: TEST_DOC_ID,
        owner_type: 'PARTNER',
        owner_id: TEST_PARTNER_ID,
        owner_name: 'Metro Wheels',
        owner_email: 'metro@wheels.com',
        owner_phone: '+919876543210',
        document_type: 'PAN',
        document_name: 'PAN Card',
        document_number: 'ABCDE1234F',
        valid_till: null,
        storage_key: 'partners/docs/pan-1.pdf',
        verification_status: 'VERIFIED',
        is_required: true,
        version: 1,
        rejection_reason: null,
        created_at: new Date('2026-09-01T10:00:00Z'),
        updated_at: new Date('2026-09-01T10:00:00Z'),
      };

      adminStorageRepository.query
        .mockResolvedValueOnce({ rows: [{ total: '1' }] })
        .mockResolvedValueOnce({ rows: [mockDoc] });

      const res = await request(app)
        .get('/api/v1/admin/storage/documents')
        .query({
          page: 1,
          limit: 10,
          ownerType: 'PARTNER',
          partnerId: TEST_PARTNER_ID,
          documentType: 'PAN',
          verificationStatus: 'VERIFIED',
          search: 'Metro',
        })
        .set('Authorization', `Bearer ${SESSIONS.storageRead}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(TEST_DOC_ID);
      expect(res.body.data[0].ownerType).toBe('PARTNER');
      expect(res.body.data[0].owner.name).toBe('Metro Wheels');
      expect(res.body.meta.total).toBe(1);
      expect(res.body.meta.page).toBe(1);
    });

    it('rejects date range exceeding 90 days with 400', async () => {
      const res = await request(app)
        .get('/api/v1/admin/storage/documents')
        .query({
          startDate: '2026-01-01T00:00:00.000Z',
          endDate: '2026-06-01T00:00:00.000Z',
        })
        .set('Authorization', `Bearer ${SESSIONS.storageRead}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('90 days');
    });

    it('rejects date range where startDate is after endDate with 400', async () => {
      const res = await request(app)
        .get('/api/v1/admin/storage/documents')
        .query({
          startDate: '2026-09-20T00:00:00.000Z',
          endDate: '2026-09-10T00:00:00.000Z',
        })
        .set('Authorization', `Bearer ${SESSIONS.storageRead}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  // ── 3. Document Detail ──────────────────────────────────────────────────────

  describe('3. GET /api/v1/admin/storage/documents/:id', () => {
    it('returns document detail with fileMetadata when S3 object exists', async () => {
      adminStorageRepository.query.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_DOC_ID,
            owner_type: 'PARTNER',
            owner_id: TEST_PARTNER_ID,
            owner_name: 'Metro Wheels',
            owner_email: 'metro@wheels.com',
            owner_phone: '+919876543210',
            document_type: 'AADHAAR',
            document_name: 'Aadhaar Card',
            document_number: '123456789012',
            valid_till: null,
            storage_key: 'partners/docs/aadhaar.pdf',
            verification_status: 'VERIFIED',
            is_required: true,
            version: 1,
            rejection_reason: null,
            created_at: new Date('2026-09-01T10:00:00Z'),
            updated_at: new Date('2026-09-01T10:00:00Z'),
          },
        ],
      });

      const res = await request(app)
        .get(`/api/v1/admin/storage/documents/${TEST_DOC_ID}`)
        .set('Authorization', `Bearer ${SESSIONS.storageRead}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(TEST_DOC_ID);
      expect(res.body.data.hasFile).toBe(true);
      expect(res.body.data.fileMetadata.contentLength).toBe(4096);
      expect(res.body.data.fileMetadata.exists).toBe(true);
    });

    it('returns 400 for malformed document UUID', async () => {
      const res = await request(app)
        .get('/api/v1/admin/storage/documents/not-a-valid-uuid')
        .set('Authorization', `Bearer ${SESSIONS.storageRead}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('returns 404 when document is not found', async () => {
      adminStorageRepository.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get('/api/v1/admin/storage/documents/da000001-9999-4000-a000-000000000000')
        .set('Authorization', `Bearer ${SESSIONS.storageRead}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  // ── 4. Signed URL Generation ────────────────────────────────────────────────

  describe('4. GET /api/v1/admin/storage/documents/:id/url', () => {
    it('returns 200 with presigned download URL and zero credential leakage', async () => {
      adminStorageRepository.query.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_DOC_ID,
            owner_type: 'PARTNER',
            owner_id: TEST_PARTNER_ID,
            owner_name: 'Metro Wheels',
            document_type: 'PAN',
            storage_key: 'partners/docs/pan.pdf',
            verification_status: 'VERIFIED',
            created_at: new Date('2026-09-01T10:00:00Z'),
            updated_at: new Date('2026-09-01T10:00:00Z'),
          },
        ],
      });

      const res = await request(app)
        .get(`/api/v1/admin/storage/documents/${TEST_DOC_ID}/url`)
        .set('Authorization', `Bearer ${SESSIONS.storageAccess}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.documentId).toBe(TEST_DOC_ID);
      expect(res.body.data.downloadUrl).toContain('https://s3.amazonaws.com');
      expect(res.body.data.expiresInSeconds).toBe(900);
      expect(res.body.data.fileSize).toBe(4096);
      expect(res.body.data.mimeType).toBe('application/pdf');

      // Security verify: No raw AWS credentials in payload
      const str = JSON.stringify(res.body);
      expect(str).not.toContain('AWS_SECRET');
      expect(str).not.toContain('secretAccessKey');
      expect(str).not.toContain('accessKeyId');
    });

    it('returns 400 when document has no storageKey attached', async () => {
      adminStorageRepository.query.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_DOC_ID,
            owner_type: 'PARTNER',
            owner_id: TEST_PARTNER_ID,
            document_type: 'PAN',
            storage_key: null,
          },
        ],
      });

      const res = await request(app)
        .get(`/api/v1/admin/storage/documents/${TEST_DOC_ID}/url`)
        .set('Authorization', `Bearer ${SESSIONS.storageAccess}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('attached file');
    });

    it('returns 404 when S3 object does not exist in bucket', async () => {
      adminStorageRepository.query.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_DOC_ID,
            owner_type: 'PARTNER',
            owner_id: TEST_PARTNER_ID,
            document_type: 'PAN',
            storage_key: 'partners/docs/missing.pdf',
          },
        ],
      });

      // Mock headObject returning 404
      const notFoundErr = new Error('NoSuchKey');
      notFoundErr.name = 'NotFound';
      notFoundErr.$metadata = { httpStatusCode: 404 };
      s3Provider.setMockS3Client({
        send: jest.fn().mockRejectedValue(notFoundErr),
      });

      const res = await request(app)
        .get(`/api/v1/admin/storage/documents/${TEST_DOC_ID}/url`)
        .set('Authorization', `Bearer ${SESSIONS.storageAccess}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('Storage object not found');
    });
  });

  // ── 5. Preview & Download ───────────────────────────────────────────────────

  describe('5. GET /api/v1/admin/storage/documents/:id/preview and /download', () => {
    it('returns preview URL configured for inline viewing', async () => {
      adminStorageRepository.query.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_DOC_ID,
            owner_type: 'VEHICLE',
            owner_id: TEST_VEHICLE_ID,
            document_type: 'RC',
            storage_key: 'vehicles/docs/rc.pdf',
          },
        ],
      });

      const res = await request(app)
        .get(`/api/v1/admin/storage/documents/${TEST_DOC_ID}/preview`)
        .set('Authorization', `Bearer ${SESSIONS.storageAccess}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.previewUrl).toContain('https://s3.amazonaws.com');
      expect(res.body.data.documentId).toBe(TEST_DOC_ID);
    });

    it('returns download URL with sanitized filename and attachment disposition', async () => {
      adminStorageRepository.query.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_DOC_ID,
            owner_type: 'PARTNER',
            owner_id: TEST_PARTNER_ID,
            document_type: 'GST_CERTIFICATE',
            storage_key: 'partners/docs/gst.pdf',
          },
        ],
      });

      const res = await request(app)
        .get(`/api/v1/admin/storage/documents/${TEST_DOC_ID}/download`)
        .set('Authorization', `Bearer ${SESSIONS.storageAccess}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.downloadUrl).toContain('https://s3.amazonaws.com');
      expect(res.body.data.filename).toBe('gst_certificate_da000001.pdf');
    });
  });

  // ── 6. Document History ─────────────────────────────────────────────────────

  describe('6. GET /api/v1/admin/storage/documents/:id/history', () => {
    it('returns chronological audit actions on the document', async () => {
      adminStorageRepository.query
        .mockResolvedValueOnce({
          rows: [
            {
              id: TEST_DOC_ID,
              owner_type: 'PARTNER',
              owner_id: TEST_PARTNER_ID,
              document_type: 'PAN',
            },
          ],
        }) // findDocumentById
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'act-1',
              actor_id: SUPER_ADMIN_USER.id,
              actor_role: 'ADMIN',
              action: 'DOCUMENT_VIEWED',
              target_resource: 'PARTNER_DOCUMENT',
              target_resource_id: TEST_DOC_ID,
              request_id: 'req-hist-1',
              metadata: { documentId: TEST_DOC_ID },
              created_at: new Date('2026-09-02T10:00:00Z'),
              actor_name: 'Super Admin',
              actor_email: 'superadmin@gongo.in',
            },
          ],
        }); // findDocumentHistory

      const res = await request(app)
        .get(`/api/v1/admin/storage/documents/${TEST_DOC_ID}/history`)
        .set('Authorization', `Bearer ${SESSIONS.storageRead}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].action).toBe('DOCUMENT_VIEWED');
    });
  });

  // ── 7. Entity Document Sub-resources ────────────────────────────────────────

  describe('7. Entity Document Sub-resources', () => {
    it('GET /api/v1/admin/storage/partners/:partnerId/documents returns partner documents', async () => {
      adminStorageRepository.query
        .mockResolvedValueOnce({
          rows: [
            {
              id: TEST_PARTNER_ID,
              business_name: 'Super Wheels',
              kyc_status: 'VERIFIED',
              city: 'Mumbai',
              owner_name: 'Sam Partner',
              email: 'sam@wheels.com',
              phone: '+919999999999',
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: TEST_DOC_ID,
              partner_id: TEST_PARTNER_ID,
              document_type: 'AADHAAR',
              document_name: 'Aadhaar',
              document_number: '123412341234',
              storage_key: 'partners/docs/aadhaar.pdf',
              verification_status: 'VERIFIED',
              is_required: true,
              version: 1,
              created_at: new Date('2026-09-01T10:00:00Z'),
              updated_at: new Date('2026-09-01T10:00:00Z'),
            },
          ],
        });

      const res = await request(app)
        .get(`/api/v1/admin/storage/partners/${TEST_PARTNER_ID}/documents`)
        .set('Authorization', `Bearer ${SESSIONS.storageRead}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.partner.businessName).toBe('Super Wheels');
      expect(res.body.data.documents).toHaveLength(1);
    });

    it('GET /api/v1/admin/storage/vehicles/:vehicleId/documents returns vehicle documents', async () => {
      adminStorageRepository.query
        .mockResolvedValueOnce({
          rows: [
            {
              id: TEST_VEHICLE_ID,
              partner_id: TEST_PARTNER_ID,
              registration_number: 'MH01AB1234',
              brand: 'Tata',
              model: 'Nexon',
              verification_status: 'VERIFIED',
              partner_name: 'Super Wheels',
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: TEST_DOC_ID,
              vehicle_id: TEST_VEHICLE_ID,
              document_type: 'RC',
              document_name: 'RC',
              document_number: 'MH01-RC-9988',
              storage_key: 'vehicles/docs/rc.pdf',
              verification_status: 'VERIFIED',
              is_required: true,
              version: 1,
              created_at: new Date('2026-09-01T10:00:00Z'),
              updated_at: new Date('2026-09-01T10:00:00Z'),
            },
          ],
        });

      const res = await request(app)
        .get(`/api/v1/admin/storage/vehicles/${TEST_VEHICLE_ID}/documents`)
        .set('Authorization', `Bearer ${SESSIONS.storageRead}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.vehicle.registrationNumber).toBe('MH01AB1234');
      expect(res.body.data.documents).toHaveLength(1);
    });

    it('GET /api/v1/admin/storage/customers/:customerId/documents returns customer documents', async () => {
      adminStorageRepository.query
        .mockResolvedValueOnce({
          rows: [
            {
              id: TEST_CUSTOMER_ID,
              name: 'John Customer',
              email: 'john@cust.com',
              phone: '+919876543210',
              role: 'CUSTOMER',
              is_active: true,
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: TEST_DOC_ID,
              user_id: TEST_CUSTOMER_ID,
              document_type: 'DRIVING_LICENSE',
              storage_key: 'customers/docs/dl.pdf',
              verification_status: 'VERIFIED',
              created_at: new Date('2026-09-01T10:00:00Z'),
              updated_at: new Date('2026-09-01T10:00:00Z'),
            },
          ],
        });

      const res = await request(app)
        .get(`/api/v1/admin/storage/customers/${TEST_CUSTOMER_ID}/documents`)
        .set('Authorization', `Bearer ${SESSIONS.storageRead}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.customer.name).toBe('John Customer');
      expect(res.body.data.documents).toHaveLength(1);
    });
  });

  // ── 8. Immutability & Modification Denial ───────────────────────────────────

  describe('8. Immutability & Modification Denial', () => {
    it('denies POST to /api/v1/admin/storage/documents (direct storage modification denied)', async () => {
      const res = await request(app)
        .post('/api/v1/admin/storage/documents')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`)
        .send({ name: 'forged.pdf' });

      expect([404, 405]).toContain(res.status);
    });

    it('denies PUT to /api/v1/admin/storage/documents/:id (direct edit denied)', async () => {
      const res = await request(app)
        .put(`/api/v1/admin/storage/documents/${TEST_DOC_ID}`)
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`)
        .send({ storageKey: 'hacked/key.pdf' });

      expect([404, 405]).toContain(res.status);
    });

    it('denies DELETE to /api/v1/admin/storage/documents/:id (direct deletion denied)', async () => {
      const res = await request(app)
        .delete(`/api/v1/admin/storage/documents/${TEST_DOC_ID}`)
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);

      expect([404, 405]).toContain(res.status);
    });
  });
});
