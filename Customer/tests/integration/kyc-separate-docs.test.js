'use strict';

const request = require('supertest');
const { setupE2EEnvironment } = require('./e2e/e2e-helper');
const s3Provider = require('../../src/services/storage/s3.provider');

const JPEG_HEADER = Buffer.from([
  0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46,
  0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x60,
]);

describe('Customer KYC Separate Aadhaar and Driving Licence Integration Tests', () => {
  let app;
  let e2eEnv;
  let customerUser;
  let customerToken;

  beforeAll(async () => {
    e2eEnv = await setupE2EEnvironment();
    app = e2eEnv.app;
    const c1 = e2eEnv.createCustomer({ name: 'KYC Separate Docs Customer' });
    customerUser = { id: c1.userId, name: c1.name };
    customerToken = c1.token;

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

  describe('Aadhaar Separate Front and Back Upload & Verification', () => {
    let frontUploadId;
    let backUploadId;

    it('1. Generates presigned URL for Aadhaar Front with side=front', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/documents/upload-url')
        .set('Authorization', customerToken)
        .send({
          documentType: 'AADHAAR',
          side: 'front',
          contentType: 'image/jpeg',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.uploadId).toBeDefined();
      expect(res.body.data.side).toBe('front');
      expect(res.body.data.storageKey).toContain('/front-');
      frontUploadId = res.body.data.uploadId;
    });

    it('2. Confirms Aadhaar Front upload and saves as PENDING', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/documents')
        .set('Authorization', customerToken)
        .send({
          uploadId: frontUploadId,
          documentType: 'AADHAAR',
          side: 'front',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.documentType).toBe('AADHAAR');
      expect(res.body.data.status).toBe('PENDING');
      expect(res.body.data.side).toBe('front');
    });

    it('3. Generates presigned URL for Aadhaar Back with side=back', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/documents/upload-url')
        .set('Authorization', customerToken)
        .send({
          documentType: 'AADHAAR',
          side: 'back',
          contentType: 'image/jpeg',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.uploadId).toBeDefined();
      expect(res.body.data.side).toBe('back');
      expect(res.body.data.storageKey).toContain('/back-');
      backUploadId = res.body.data.uploadId;
    });

    it('4. Confirms Aadhaar Back upload without overwriting or deleting Aadhaar Front', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/documents')
        .set('Authorization', customerToken)
        .send({
          uploadId: backUploadId,
          documentType: 'AADHAAR',
          side: 'back',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.documentType).toBe('AADHAAR');
      expect(res.body.data.status).toBe('PENDING');
      expect(res.body.data.side).toBe('back');

      // Verify both front and back are present in GET /documents
      const docsRes = await request(app)
        .get('/api/v1/customers/me/documents')
        .set('Authorization', customerToken);

      expect(docsRes.status).toBe(200);
      const aadhaarDocs = docsRes.body.data.filter((d) => d.documentType === 'AADHAAR');
      expect(aadhaarDocs.length).toBeGreaterThanOrEqual(2);
      const hasFront = aadhaarDocs.some((d) => d.side === 'front');
      const hasBack = aadhaarDocs.some((d) => d.side === 'back');
      expect(hasFront).toBe(true);
      expect(hasBack).toBe(true);
    });

    it('5. Verifies 12-digit Aadhaar number and sets status to VERIFIED', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/documents')
        .set('Authorization', customerToken)
        .send({
          documentType: 'AADHAAR',
          documentNumber: '542189763412',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.documentType).toBe('AADHAAR');
      expect(res.body.data.status).toBe('VERIFIED');
      expect(res.body.data.documentNumber).toContain('XXXX XXXX 3412');

      // Verify in GET /documents that documents are now VERIFIED
      const docsRes = await request(app)
        .get('/api/v1/customers/me/documents')
        .set('Authorization', customerToken);

      const aadhaarDocs = docsRes.body.data.filter((d) => d.documentType === 'AADHAAR');
      expect(aadhaarDocs.some((d) => d.status === 'VERIFIED')).toBe(true);
    });
  });

  describe('Missing/Null Field Prevention', () => {
    it('6. Rejects document number submission with 400 DOCUMENTS_REQUIRED if no photos uploaded, without crashing', async () => {
      // Create a fresh user with no documents
      const freshUser = e2eEnv.createCustomer({ name: 'Fresh Customer' });

      const res = await request(app)
        .post('/api/v1/customers/me/documents')
        .set('Authorization', freshUser.token)
        .send({
          documentType: 'AADHAAR',
          documentNumber: '123456789012',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('DOCUMENTS_REQUIRED');
      expect(res.body.message).not.toContain('A required field was omitted or null');
    });
  });

  describe('Driving Licence Independent Workflow', () => {
    let dlFrontUploadId;
    let dlBackUploadId;

    it('7. Generates presigned URL for Driving Licence Front independently', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/documents/upload-url')
        .set('Authorization', customerToken)
        .send({
          documentType: 'DRIVING_LICENSE',
          side: 'front',
          contentType: 'image/jpeg',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.uploadId).toBeDefined();
      dlFrontUploadId = res.body.data.uploadId;
    });

    it('8. Confirms DL Front upload and preserves Aadhaar VERIFIED status intact', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/documents')
        .set('Authorization', customerToken)
        .send({
          uploadId: dlFrontUploadId,
          documentType: 'DRIVING_LICENSE',
          side: 'front',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.documentType).toBe('DRIVING_LICENSE');
      expect(res.body.data.status).toBe('PENDING');

      // Verify Aadhaar is still VERIFIED
      const docsRes = await request(app)
        .get('/api/v1/customers/me/documents')
        .set('Authorization', customerToken);

      const aadhaarDocs = docsRes.body.data.filter((d) => d.documentType === 'AADHAAR');
      expect(aadhaarDocs.some((d) => d.status === 'VERIFIED')).toBe(true);
    });

    it('9. Confirms DL Back upload independently', async () => {
      const presign = await request(app)
        .post('/api/v1/customers/me/documents/upload-url')
        .set('Authorization', customerToken)
        .send({
          documentType: 'DRIVING_LICENSE',
          side: 'back',
          contentType: 'image/jpeg',
        });

      dlBackUploadId = presign.body.data.uploadId;

      const res = await request(app)
        .post('/api/v1/customers/me/documents')
        .set('Authorization', customerToken)
        .send({
          uploadId: dlBackUploadId,
          documentType: 'DRIVING_LICENSE',
          side: 'back',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.documentType).toBe('DRIVING_LICENSE');
      expect(res.body.data.side).toBe('back');
    });

    it('10. Submitting DL number transitions DL to PENDING (under review) without altering Aadhaar VERIFIED', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/documents')
        .set('Authorization', customerToken)
        .send({
          documentType: 'DRIVING_LICENSE',
          documentNumber: 'DL-1420110012345',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.documentType).toBe('DRIVING_LICENSE');
      expect(res.body.data.status).toBe('PENDING');

      // Verify Aadhaar still VERIFIED
      const docsRes = await request(app)
        .get('/api/v1/customers/me/documents')
        .set('Authorization', customerToken);

      const aadhaarDocs = docsRes.body.data.filter((d) => d.documentType === 'AADHAAR');
      expect(aadhaarDocs.some((d) => d.status === 'VERIFIED')).toBe(true);

      const dlDocs = docsRes.body.data.filter((d) => d.documentType === 'DRIVING_LICENSE');
      expect(dlDocs.length).toBeGreaterThanOrEqual(2);
    });
  });
});
