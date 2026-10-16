'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const s3Provider = require('../../src/providers/s3');
const PartnerRepository = require('../../src/repositories/partner.repository');
const storageUploadRepository = require('../../src/repositories/storageUpload.repository');
const pool = require('../../src/db/pool');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Integration: Storage & S3 Direct Upload API', () => {
  let app;
  let mockAuth;
  const partner1Id = '11111111-1111-1111-1111-111111111111';
  const partner2Id = '22222222-2222-2222-2222-222222222222';
  const uploadId = '44444444-4444-4444-4444-444444444444';

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    mockAuth = {
      verifyIdToken: jest.fn(async (token) => {
        if (token === 'partner-1-token') {
          return { uid: 'uid-partner-1', phone_number: '+919876543210' };
        }
        if (token === 'partner-2-token') {
          return { uid: 'uid-partner-2', phone_number: '+919876543211' };
        }
        if (token === 'customer-token') {
          return { uid: 'uid-customer', phone_number: '+919876543299' };
        }
        const err = new Error('Invalid token');
        err.code = 'auth/invalid-id-token';
        throw err;
      }),
      revokeRefreshTokens: jest.fn().mockResolvedValue(true),
    };
    setMockFirebaseAuth(mockAuth);

    PartnerRepository.setMockPartnerResolver((idOrAuth) => {
      if (idOrAuth === 'uid-partner-1' || idOrAuth === partner1Id) {
        return {
          id: partner1Id,
          partnerId: partner1Id,
          userId: 'user-partner-1',
          auth_id: 'uid-partner-1',
          role: 'PARTNER',
          is_active: true,
          partner_status: 'ONLINE',
          kyc_status: 'VERIFIED',
        };
      }
      if (idOrAuth === 'uid-partner-2' || idOrAuth === partner2Id) {
        return {
          id: partner2Id,
          partnerId: partner2Id,
          userId: 'user-partner-2',
          auth_id: 'uid-partner-2',
          role: 'PARTNER',
          is_active: true,
          partner_status: 'OFFLINE',
          kyc_status: 'PENDING',
        };
      }
      if (idOrAuth === 'uid-customer') {
        return {
          id: 'cust-1',
          userId: 'user-cust-1',
          auth_id: 'uid-customer',
          role: 'CUSTOMER',
          is_active: true,
        };
      }
      return null;
    });

    s3Provider.setMockPresigner(
      jest.fn().mockResolvedValue('https://mock-s3.ap-south-1.amazonaws.com/test-bucket/direct-url'),
    );
  });

  afterEach(() => {
    PartnerRepository.setMockPartnerResolver(null);
    jest.restoreAllMocks();
    s3Provider.resetS3Client();
  });

  describe('1. Authentication & Role Authorization', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(app)
        .post('/api/v1/storage/presign')
        .send({
          entityType: 'PROFILE_IMAGE',
          fileName: 'photo.jpg',
          contentType: 'image/jpeg',
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTH_REQUIRED);
    });

    it('rejects non-PARTNER roles with 403 FORBIDDEN', async () => {
      const res = await request(app)
        .post('/api/v1/storage/presign')
        .set('Authorization', 'Bearer customer-token')
        .send({
          entityType: 'PROFILE_IMAGE',
          fileName: 'photo.jpg',
          contentType: 'image/jpeg',
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });
  });

  describe('2. POST /api/v1/storage/presign', () => {
    it('successfully generates presigned PUT URL and registers upload session', async () => {
      jest.spyOn(storageUploadRepository, 'createUpload').mockResolvedValueOnce({
        id: uploadId,
        partner_id: partner1Id,
        entity_type: 'PROFILE_IMAGE',
        storage_key: `partners/${partner1Id}/profile/abc.jpg`,
        content_type: 'image/jpeg',
        expected_size_bytes: 5242880,
        status: 'PENDING',
      });

      const res = await request(app)
        .post('/api/v1/storage/presign')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          entityType: 'PROFILE_IMAGE',
          fileName: 'my_avatar.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('uploadId', uploadId);
      expect(res.body.data).toHaveProperty('uploadUrl');
      expect(res.body.data.storageKey).toMatch(new RegExp(`^partners/${partner1Id}/profile/[0-9a-f-]+\\.png$`));
      expect(res.body.data.headers).toEqual({
        'Content-Type': 'image/png',
        'x-amz-server-side-encryption': 'AES256',
      });
      expect(res.body.data.maxSizeBytes).toBe(5242880);
    });

    it('rejects mass assignment when client attempts to inject storageKey or bucket', async () => {
      const res = await request(app)
        .post('/api/v1/storage/presign')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          entityType: 'PROFILE_IMAGE',
          fileName: 'avatar.jpg',
          contentType: 'image/jpeg',
          storageKey: 'partners/victim/avatar.jpg',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
    });

    it('rejects path traversal attempts in fileName', async () => {
      const res = await request(app)
        .post('/api/v1/storage/presign')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          entityType: 'PROFILE_IMAGE',
          fileName: '../../etc/passwd.jpg',
          contentType: 'image/jpeg',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('path traversal');
    });

    it('rejects disallowed file extensions', async () => {
      const res = await request(app)
        .post('/api/v1/storage/presign')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          entityType: 'PROFILE_IMAGE',
          fileName: 'malicious.exe',
          contentType: 'application/octet-stream',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('3. POST /api/v1/storage/complete', () => {
    it('returns 400 when file was not uploaded to S3 (HeadObject 404)', async () => {
      jest.spyOn(storageUploadRepository, 'findByIdAndPartnerId').mockResolvedValueOnce({
        id: uploadId,
        partner_id: partner1Id,
        status: 'PENDING',
        storage_key: `partners/${partner1Id}/profile/abc.jpg`,
        expires_at: new Date(Date.now() + 600000),
      });

      const notFoundErr = new Error('Object not found');
      notFoundErr.notFound = true;
      notFoundErr.code = 'S3_OBJECT_NOT_FOUND';
      jest.spyOn(s3Provider, 'headObject').mockRejectedValueOnce(notFoundErr);

      const res = await request(app)
        .post('/api/v1/storage/complete')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          uploadId,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('File was not uploaded to storage');
    });

    it('successfully confirms upload and synchronizes profile image URL', async () => {
      jest.spyOn(storageUploadRepository, 'findByIdAndPartnerId').mockResolvedValueOnce({
        id: uploadId,
        partner_id: partner1Id,
        status: 'PENDING',
        entity_type: 'PROFILE_IMAGE',
        storage_key: `partners/${partner1Id}/profile/avatar.png`,
        expected_size_bytes: 5242880,
        expires_at: new Date(Date.now() + 600000),
      });

      jest.spyOn(s3Provider, 'headObject').mockResolvedValueOnce({
        contentLength: 154320,
        contentType: 'image/png',
      });

      jest.spyOn(pool, 'transaction').mockImplementationOnce(async (cb) => cb({}));

      jest.spyOn(storageUploadRepository, 'markCompleted').mockResolvedValueOnce({
        id: uploadId,
        entity_type: 'PROFILE_IMAGE',
        storage_key: `partners/${partner1Id}/profile/avatar.png`,
      });

      jest.spyOn(PartnerRepository.prototype, 'updatePartner').mockResolvedValueOnce({});

      const res = await request(app)
        .post('/api/v1/storage/complete')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          uploadId,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({
        uploadId,
        status: 'COMPLETED',
        entityType: 'PROFILE_IMAGE',
        storageKey: `partners/${partner1Id}/profile/avatar.png`,
        sizeBytes: 154320,
      });
    }, 15000);

    it('enforces BOLA: Partner 2 cannot complete an upload owned by Partner 1', async () => {
      // storageUploadRepository.findByIdAndPartnerId returns null for (uploadId, partner2Id)
      jest.spyOn(storageUploadRepository, 'findByIdAndPartnerId').mockResolvedValueOnce(null);

      const res = await request(app)
        .post('/api/v1/storage/complete')
        .set('Authorization', 'Bearer partner-2-token')
        .send({
          uploadId,
        });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.NOT_FOUND);
    });

    it('idempotently returns existing success if upload is already completed', async () => {
      jest.spyOn(storageUploadRepository, 'findByIdAndPartnerId').mockResolvedValueOnce({
        id: uploadId,
        partner_id: partner1Id,
        status: 'COMPLETED',
        entity_type: 'PROFILE_IMAGE',
        storage_key: `partners/${partner1Id}/profile/avatar.png`,
        actual_size_bytes: 154320,
      });

      const res = await request(app)
        .post('/api/v1/storage/complete')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          uploadId,
        });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('COMPLETED');
      expect(res.body.data.uploadId).toBe(uploadId);
    });
  });

  describe('4. POST /api/v1/storage/access-url', () => {
    it('successfully generates short-lived presigned GET URL for partner-owned object', async () => {
      jest.spyOn(s3Provider, 'createPresignedGetUrl').mockResolvedValueOnce({
        downloadUrl: 'https://mock-s3.ap-south-1.amazonaws.com/test-bucket/download-file',
        expiresInSeconds: 300,
      });

      const res = await request(app)
        .post('/api/v1/storage/access-url')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          storageKey: `partners/${partner1Id}/kyc/aadhaar/doc.pdf`,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.downloadUrl).toBe(
        'https://mock-s3.ap-south-1.amazonaws.com/test-bucket/download-file',
      );
      expect(res.body.data.expiresInSeconds).toBe(300);
      expect(res.body.data.storageKey).toBe(`partners/${partner1Id}/kyc/aadhaar/doc.pdf`);
    });

    it('enforces BOLA: Partner 1 cannot generate access URL for Partner 2 files', async () => {
      const res = await request(app)
        .post('/api/v1/storage/access-url')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          storageKey: `partners/${partner2Id}/kyc/pan/private.pdf`,
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });

    it('rejects mass-assignment attempts on /access-url (e.g. attempting to supply downloadUrl or status)', async () => {
      const res = await request(app)
        .post('/api/v1/storage/access-url')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          storageKey: `partners/${partner1Id}/profile/pic.jpg`,
          status: 'HACKED',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
    });
  });
});
