'use strict';

const request = require('supertest');
const { setupE2EEnvironment } = require('./e2e/e2e-helper');
const s3Provider = require('../../src/services/storage/s3.provider');

const JPEG_HEADER = Buffer.from([
  0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46,
  0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x60,
]);

describe('Customer Storage & Upload Integration Tests', () => {
  let app;
  let customerUser;
  let customerToken;
  let otherCustomerToken;

  beforeAll(async () => {
    const env = await setupE2EEnvironment();
    app = env.app;
    const c1 = env.createCustomer({ name: 'Storage Customer' });
    const c2 = env.createCustomer({ name: 'Other Customer' });
    customerUser = { id: c1.userId, name: c1.name };
    customerToken = c1.token;
    otherCustomerToken = c2.token;

    // Mock S3 provider for integration tests
    s3Provider.setMockPresigner(async (client, command, options) => {
      if (command.constructor.name === 'PutObjectCommand') {
        return `https://mock-s3.gongo.in/${command.input.Bucket}/${command.input.Key}?expires=${options.expiresIn}`;
      }
      return `https://mock-s3.gongo.in/${command.input.Bucket}/${command.input.Key}?signed=true`;
    });

    s3Provider.setMockS3Client({
      send: jest.fn().mockImplementation(async (command) => {
        const { name } = command.constructor;
        if (name === 'HeadObjectCommand') {
          return {
            ContentLength: 1024 * 100, // 100 KB
            ContentType: 'image/jpeg',
            ETag: '"mock-etag"',
          };
        }
        if (name === 'GetObjectCommand') {
          return {
            Body: JPEG_HEADER,
          };
        }
        if (name === 'DeleteObjectCommand') {
          return {};
        }
        return {};
      }),
    });
  });

  afterAll(() => {
    s3Provider.resetS3Client();
  });

  describe('POST /api/v1/customers/me/documents/upload-url', () => {
    it('1. rejects unauthenticated requests with 401', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/documents/upload-url')
        .send({
          documentType: 'DRIVING_LICENSE',
          contentType: 'image/jpeg',
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('2. rejects non-customer roles with 403', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/documents/upload-url')
        .set('Authorization', 'Bearer token-partner')
        .send({
          documentType: 'DRIVING_LICENSE',
          contentType: 'image/jpeg',
        });

      expect(res.status).toBe(403);
    });

    it('3. rejects unsupported document types with 400', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/documents/upload-url')
        .set('Authorization', customerToken)
        .send({
          documentType: 'PASSPORT',
          contentType: 'image/jpeg',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_DOCUMENT_TYPE');
    });

    it('4. rejects unsupported MIME types with 400', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/documents/upload-url')
        .set('Authorization', customerToken)
        .send({
          documentType: 'DRIVING_LICENSE',
          contentType: 'application/x-executable',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('UNSUPPORTED_MIME_TYPE');
    });

    it('5. rejects oversized requested fileSize with 400', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/documents/upload-url')
        .set('Authorization', customerToken)
        .send({
          documentType: 'DRIVING_LICENSE',
          contentType: 'image/jpeg',
          fileSize: 1024 * 1024 * 50, // 50 MB
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('FILE_TOO_LARGE');
    });

    it('6. rejects forbidden client fields in request body with 400', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/documents/upload-url')
        .set('Authorization', customerToken)
        .send({
          documentType: 'DRIVING_LICENSE',
          contentType: 'image/jpeg',
          storageKey: 'arbitrary/path/hack.jpg',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('FORBIDDEN_PAYLOAD_FIELD');
    });

    it('7. successfully generates presigned upload URL for DRIVING_LICENSE', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/documents/upload-url')
        .set('Authorization', customerToken)
        .send({
          documentType: 'DRIVING_LICENSE',
          contentType: 'image/jpeg',
          fileSize: 1024 * 1024 * 2,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.uploadId).toBeDefined();
      const expectedKeyPattern = new RegExp(`^customers/${customerUser.id}/documents/driving_license/`);
      expect(res.body.data.storageKey).toMatch(expectedKeyPattern);
      expect(res.body.data.expiresInSeconds).toBe(900);
    });
  });

  describe('POST /api/v1/customers/me/documents', () => {
    let validUploadId;

    beforeEach(async () => {
      const presignRes = await request(app)
        .post('/api/v1/customers/me/documents/upload-url')
        .set('Authorization', customerToken)
        .send({
          documentType: 'DRIVING_LICENSE',
          contentType: 'image/jpeg',
        });
      validUploadId = presignRes.body.data.uploadId;
    });

    it('8. rejects unauthenticated completion with 401', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/documents')
        .send({ uploadId: validUploadId });

      expect(res.status).toBe(401);
    });

    it('9. rejects non-UUID or missing uploadId with 400', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/documents')
        .set('Authorization', customerToken)
        .send({ uploadId: 'invalid-id' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_UPLOAD_ID');
    });

    it('10. prevents IDOR: rejects completion when attempted by a different customer (403)', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/documents')
        .set('Authorization', otherCustomerToken)
        .send({ uploadId: validUploadId });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('UNAUTHORIZED_UPLOAD_ACCESS');
    });

    it('11. successfully completes KYC document upload and sets status PENDING', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/documents')
        .set('Authorization', customerToken)
        .send({ uploadId: validUploadId });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.documentType).toBe('DRIVING_LICENSE');
      expect(res.body.data.status).toBe('PENDING');
      expect(res.body.data.storageKey).toBeUndefined(); // Storage key is sanitized/masked
    });

    it('12. newly uploaded document is visible in GET /api/v1/customers/me/documents', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me/documents')
        .set('Authorization', customerToken);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      const dl = res.body.data.find((d) => d.documentType === 'DRIVING_LICENSE');
      expect(dl).toBeDefined();
      expect(dl.status).toBe('PENDING');
    });
  });

  describe('POST /api/v1/customers/me/avatar/upload-url', () => {
    it('13. rejects unauthenticated requests with 401', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/avatar/upload-url')
        .send({ contentType: 'image/png' });

      expect(res.status).toBe(401);
    });

    it('14. rejects unsupported MIME types like PDF for avatar with 400', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/avatar/upload-url')
        .set('Authorization', customerToken)
        .send({ contentType: 'application/pdf' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('UNSUPPORTED_MIME_TYPE');
    });

    it('15. rejects oversized avatar (> 5MB) with 400', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/avatar/upload-url')
        .set('Authorization', customerToken)
        .send({
          contentType: 'image/png',
          fileSize: 1024 * 1024 * 10,
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('FILE_TOO_LARGE');
    });

    it('16. successfully generates presigned upload URL for avatar', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/avatar/upload-url')
        .set('Authorization', customerToken)
        .send({ contentType: 'image/png' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.uploadId).toBeDefined();
      expect(res.body.data.storageKey).toMatch(new RegExp(`^customers/${customerUser.id}/(photo|profile)/`));
    });
  });

  describe('POST /api/v1/customers/me/avatar', () => {
    let validAvatarUploadId;

    beforeEach(async () => {
      const presignRes = await request(app)
        .post('/api/v1/customers/me/avatar/upload-url')
        .set('Authorization', customerToken)
        .send({ contentType: 'image/jpeg' });
      validAvatarUploadId = presignRes.body.data.uploadId;
    });

    it('17. rejects unauthenticated avatar completion with 401', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/avatar')
        .send({ uploadId: validAvatarUploadId });

      expect(res.status).toBe(401);
    });

    it('18. prevents IDOR: rejects completion when attempted by a different customer (403)', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/avatar')
        .set('Authorization', otherCustomerToken)
        .send({ uploadId: validAvatarUploadId });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('UNAUTHORIZED_UPLOAD_ACCESS');
    });

    it('19. successfully completes avatar upload and updates profile', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/avatar')
        .set('Authorization', customerToken)
        .send({ uploadId: validAvatarUploadId });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.avatarUrl).toContain('mock-s3.gongo.in');
      expect(res.body.data.profileImage).toBe(res.body.data.avatarUrl);
    });

    it('20. avatar is reflected in GET /api/v1/customers/me and PATCH remains compatible', async () => {
      const getRes = await request(app)
        .get('/api/v1/customers/me')
        .set('Authorization', customerToken);

      expect(getRes.status).toBe(200);
      expect(getRes.body.data.avatarUrl).toContain('mock-s3.gongo.in');
      expect(getRes.body.data.profileImage).toBe(getRes.body.data.avatarUrl);

      // Verify PATCH /customers/me does not break
      const patchRes = await request(app)
        .patch('/api/v1/customers/me')
        .set('Authorization', customerToken)
        .send({ name: 'Updated Name After Avatar' });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.data.name).toBe('Updated Name After Avatar');
      expect(patchRes.body.data.avatarUrl).toContain('mock-s3.gongo.in');
    });
  });
});
