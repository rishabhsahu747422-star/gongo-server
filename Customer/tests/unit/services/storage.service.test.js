'use strict';

const StorageService = require('../../../src/services/storage.service');
const s3Provider = require('../../../src/services/storage/s3.provider');
const {
  CUSTOMER_DOCUMENT_TYPES,
} = require('../../../src/constants/storage');

describe('StorageService Unit Tests', () => {
  let mockCustomerRepo;
  let mockDocumentRepo;
  let mockRedis;
  let mockS3;
  let storageService;

  const testCustomerId = '11111111-1111-1111-1111-111111111111';
  const otherCustomerId = '22222222-2222-2222-2222-222222222222';

  beforeEach(() => {
    mockCustomerRepo = {
      findById: jest.fn().mockResolvedValue({
        id: testCustomerId,
        role: 'customer',
        name: 'Test Customer',
        phone: '9876543210',
        email: 'customer@gongo.in',
        isActive: true,
        avatarStorageKey: null,
      }),
      updateAvatarStorageKey: jest.fn().mockImplementation((id, key) => Promise.resolve({
        id,
        role: 'customer',
        name: 'Test Customer',
        phone: '9876543210',
        email: 'customer@gongo.in',
        isActive: true,
        avatarStorageKey: key,
      })),
    };

    mockDocumentRepo = {
      findLatestByUserAndType: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((data) => Promise.resolve({
        id: 'doc-uuid-1',
        userId: data.userId,
        documentType: data.documentType,
        status: data.status,
        storageKey: data.storageKey,
        metadata: data.metadata,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
      updateDocument: jest.fn().mockImplementation((id, data) => Promise.resolve({
        id,
        userId: testCustomerId,
        documentType: 'DRIVING_LICENSE',
        status: data.status || 'PENDING',
        storageKey: data.storageKey,
        metadata: data.metadata,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
    };

    const redisStore = new Map();
    mockRedis = {
      set: jest.fn().mockImplementation((key, val) => {
        redisStore.set(key, val);
        return Promise.resolve('OK');
      }),
      get: jest.fn().mockImplementation((key) => Promise.resolve(redisStore.get(key) || null)),
      del: jest.fn().mockImplementation((key) => {
        redisStore.delete(key);
        return Promise.resolve(1);
      }),
      _store: redisStore,
    };

    mockS3 = {
      createPresignedPutUrl: jest.fn().mockResolvedValue({
        uploadUrl: 'https://s3.amazonaws.com/test-bucket/upload',
        key: 'test-key',
        expiresInSeconds: 900,
        headers: { 'Content-Type': 'image/jpeg', 'x-amz-server-side-encryption': 'AES256' },
      }),
      createPresignedGetUrl: jest.fn().mockResolvedValue({
        downloadUrl: 'https://s3.amazonaws.com/test-bucket/download-signed',
        expiresInSeconds: 3600,
      }),
      headObject: jest.fn().mockResolvedValue({
        contentLength: 1024 * 50,
        contentType: 'image/jpeg',
        eTag: '"test-etag"',
      }),
      deleteObject: jest.fn().mockResolvedValue({ success: true }),
      getObjectHeaderBytes: jest.fn().mockResolvedValue(
        Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]),
      ),
      validateMagicBytes: jest.fn().mockReturnValue(true),
    };

    const StorageServiceClass = StorageService.constructor;
    storageService = new StorageServiceClass({
      customerRepo: mockCustomerRepo,
      documentRepo: mockDocumentRepo,
      redis: mockRedis,
      s3: mockS3,
    });
  });

  describe('KYC Document Upload Flow', () => {
    it('1. generates presigned PUT URL and stores upload session in Redis', async () => {
      const res = await storageService.createDocumentUploadUrl({
        customerId: testCustomerId,
        documentType: CUSTOMER_DOCUMENT_TYPES.DRIVING_LICENSE,
        contentType: 'image/jpeg',
        fileSize: 1024 * 1024,
      });

      expect(res.uploadId).toBeDefined();
      expect(res.uploadUrl).toBe('https://s3.amazonaws.com/test-bucket/upload');
      expect(res.storageKey).toMatch(/^customers\/11111111-1111-1111-1111-111111111111\/documents\/driving_license\/[0-9a-f-]+\.jpg$/);
      expect(res.expiresInSeconds).toBe(900);

      // Verify session stored in Redis
      expect(mockRedis.set).toHaveBeenCalledTimes(1);
      const stored = JSON.parse(mockRedis._store.get(`storage:upload:${res.uploadId}`));
      expect(stored.customerId).toBe(testCustomerId);
      expect(stored.documentType).toBe('DRIVING_LICENSE');
      expect(stored.entityType).toBe('KYC_DOCUMENT');
    });

    it('2. rejects upload URL if customer is deactivated', async () => {
      mockCustomerRepo.findById.mockResolvedValueOnce({
        id: testCustomerId,
        isActive: false,
      });

      await expect(
        storageService.createDocumentUploadUrl({
          customerId: testCustomerId,
          documentType: 'DRIVING_LICENSE',
          contentType: 'image/jpeg',
          fileSize: 1000,
        }),
      ).rejects.toThrow('Account is deactivated');
    });

    it('3. completes document upload when S3 object exists and magic bytes match', async () => {
      const { uploadId } = await storageService.createDocumentUploadUrl({
        customerId: testCustomerId,
        documentType: 'DRIVING_LICENSE',
        contentType: 'image/jpeg',
        fileSize: 1024 * 1024,
      });

      const doc = await storageService.completeDocumentUpload({
        customerId: testCustomerId,
        uploadId,
      });

      expect(doc.id).toBe('doc-uuid-1');
      expect(doc.documentType).toBe('DRIVING_LICENSE');
      expect(doc.status).toBe('PENDING');
      expect(mockDocumentRepo.create).toHaveBeenCalledTimes(1);
      expect(mockRedis.del).toHaveBeenCalledWith(`storage:upload:${uploadId}`);
    });

    it('4. rejects completion if upload session is expired or not found', async () => {
      await expect(
        storageService.completeDocumentUpload({
          customerId: testCustomerId,
          uploadId: '00000000-0000-0000-0000-000000000000',
        }),
      ).rejects.toThrow('Upload session not found or has expired');
    });

    it('5. prevents IDOR: rejects completion if upload session belongs to another customer', async () => {
      const { uploadId } = await storageService.createDocumentUploadUrl({
        customerId: testCustomerId,
        documentType: 'DRIVING_LICENSE',
        contentType: 'image/jpeg',
        fileSize: 1024 * 1024,
      });

      await expect(
        storageService.completeDocumentUpload({
          customerId: otherCustomerId,
          uploadId,
        }),
      ).rejects.toThrow('You are not authorized to complete this upload session');
    });

    it('6. rejects completion if S3 HeadObject reports object not found', async () => {
      const { uploadId } = await storageService.createDocumentUploadUrl({
        customerId: testCustomerId,
        documentType: 'DRIVING_LICENSE',
        contentType: 'image/jpeg',
        fileSize: 1024 * 1024,
      });

      const notFoundErr = new Error('Not found');
      notFoundErr.notFound = true;
      mockS3.headObject.mockRejectedValueOnce(notFoundErr);

      await expect(
        storageService.completeDocumentUpload({
          customerId: testCustomerId,
          uploadId,
        }),
      ).rejects.toThrow('File was not uploaded to storage');
    });

    it('7. rejects completion and deletes S3 object if file exceeds size limit', async () => {
      const { uploadId } = await storageService.createDocumentUploadUrl({
        customerId: testCustomerId,
        documentType: 'DRIVING_LICENSE',
        contentType: 'image/jpeg',
        fileSize: 1024,
      });

      mockS3.headObject.mockResolvedValueOnce({
        contentLength: 1024 * 1024 * 20, // 20 MB > max
        contentType: 'image/jpeg',
      });

      await expect(
        storageService.completeDocumentUpload({
          customerId: testCustomerId,
          uploadId,
        }),
      ).rejects.toThrow('Uploaded file size');

      expect(mockS3.deleteObject).toHaveBeenCalledTimes(1);
    });

    it('8. rejects completion and deletes S3 object if magic-byte validation fails', async () => {
      const { uploadId } = await storageService.createDocumentUploadUrl({
        customerId: testCustomerId,
        documentType: 'DRIVING_LICENSE',
        contentType: 'image/jpeg',
        fileSize: 1024 * 1024,
      });

      mockS3.validateMagicBytes.mockReturnValueOnce(false);

      await expect(
        storageService.completeDocumentUpload({
          customerId: testCustomerId,
          uploadId,
        }),
      ).rejects.toThrow('Uploaded file binary signature does not match declared content type');

      expect(mockS3.deleteObject).toHaveBeenCalledTimes(1);
    });

    it('9. updates existing pending document and cleans up old S3 object', async () => {
      mockDocumentRepo.findLatestByUserAndType.mockResolvedValueOnce({
        id: 'existing-doc-uuid',
        userId: testCustomerId,
        documentType: 'DRIVING_LICENSE',
        status: 'PENDING',
        storageKey: 'customers/1111/documents/driving_license/old.jpg',
      });

      const { uploadId, storageKey } = await storageService.createDocumentUploadUrl({
        customerId: testCustomerId,
        documentType: 'DRIVING_LICENSE',
        contentType: 'image/jpeg',
        fileSize: 1024 * 1024,
      });

      const doc = await storageService.completeDocumentUpload({
        customerId: testCustomerId,
        uploadId,
      });

      expect(mockDocumentRepo.updateDocument).toHaveBeenCalledWith(
        'existing-doc-uuid',
        expect.objectContaining({ storageKey, status: 'PENDING' }),
      );
      expect(mockS3.deleteObject).toHaveBeenCalledWith({ key: 'customers/1111/documents/driving_license/old.jpg' });
      expect(doc.status).toBe('PENDING');
    });
  });

  describe('Customer Avatar Upload Flow', () => {
    it('10. generates presigned PUT URL for avatar upload', async () => {
      const res = await storageService.createAvatarUploadUrl({
        customerId: testCustomerId,
        contentType: 'image/png',
        fileSize: 1024 * 500,
      });

      expect(res.uploadId).toBeDefined();
      expect(res.storageKey).toBe('customers/11111111-1111-1111-1111-111111111111/photo/profile.png');
      expect(res.maxSizeBytes).toBe(1024 * 500);

      const stored = JSON.parse(mockRedis._store.get(`storage:upload:${res.uploadId}`));
      expect(stored.customerId).toBe(testCustomerId);
      expect(stored.entityType).toBe('AVATAR');
    });

    it('11. completes avatar upload, updates user, and returns presigned download URL', async () => {
      const { uploadId, storageKey } = await storageService.createAvatarUploadUrl({
        customerId: testCustomerId,
        contentType: 'image/png',
        fileSize: 1024 * 500,
      });

      const profile = await storageService.completeAvatarUpload({
        customerId: testCustomerId,
        uploadId,
      });

      expect(mockCustomerRepo.updateAvatarStorageKey).toHaveBeenCalledWith(
        testCustomerId,
        storageKey,
      );
      expect(profile.avatarUrl).toBe('https://s3.amazonaws.com/test-bucket/download-signed');
      expect(profile.profileImage).toBe('https://s3.amazonaws.com/test-bucket/download-signed');
      expect(mockRedis.del).toHaveBeenCalledWith(`storage:upload:${uploadId}`);
    });

    it('12. cleans up previous avatar S3 object on replacement', async () => {
      const { uploadId } = await storageService.createAvatarUploadUrl({
        customerId: testCustomerId,
        contentType: 'image/png',
        fileSize: 1024 * 500,
      });

      mockCustomerRepo.findById.mockResolvedValueOnce({
        id: testCustomerId,
        role: 'customer',
        name: 'Test Customer',
        phone: '9876543210',
        email: 'customer@gongo.in',
        isActive: true,
        avatarStorageKey: 'customers/1111/profile/old-avatar.jpg',
      });

      await storageService.completeAvatarUpload({
        customerId: testCustomerId,
        uploadId,
      });

      expect(mockS3.deleteObject).toHaveBeenCalledWith({ key: 'customers/1111/profile/old-avatar.jpg' });
    });

    it('13. prevents IDOR on avatar completion', async () => {
      const { uploadId } = await storageService.createAvatarUploadUrl({
        customerId: testCustomerId,
        contentType: 'image/jpeg',
        fileSize: 1024 * 500,
      });

      await expect(
        storageService.completeAvatarUpload({
          customerId: otherCustomerId,
          uploadId,
        }),
      ).rejects.toThrow('You are not authorized to complete this upload session');
    });
  });

  describe('Magic Bytes Utility', () => {
    it('14. correctly validates JPEG magic bytes', () => {
      const validJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
      expect(s3Provider.validateMagicBytes(validJpeg, 'image/jpeg')).toBe(true);

      const invalidJpeg = Buffer.from([0x00, 0x00, 0x00, 0x00]);
      expect(s3Provider.validateMagicBytes(invalidJpeg, 'image/jpeg')).toBe(false);
    });

    it('15. correctly validates PNG magic bytes', () => {
      const validPng = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      expect(s3Provider.validateMagicBytes(validPng, 'image/png')).toBe(true);

      const invalidPng = Buffer.from([0x89, 0x50, 0x4E, 0x00, 0x00, 0x00, 0x00, 0x00]);
      expect(s3Provider.validateMagicBytes(invalidPng, 'image/png')).toBe(false);
    });

    it('16. correctly validates WebP magic bytes', () => {
      const validWebp = Buffer.from('RIFF\x20\x00\x00\x00WEBPVP8 \x14\x00\x00\x00', 'binary');
      expect(s3Provider.validateMagicBytes(validWebp, 'image/webp')).toBe(true);
    });

    it('17. correctly validates PDF magic bytes', () => {
      const validPdf = Buffer.from('%PDF-1.7\n%12345', 'utf8');
      expect(s3Provider.validateMagicBytes(validPdf, 'application/pdf')).toBe(true);

      const invalidPdf = Buffer.from('NOTAPDF', 'utf8');
      expect(s3Provider.validateMagicBytes(invalidPdf, 'application/pdf')).toBe(false);
    });
  });
});
