'use strict';

const storageService = require('../../src/services/storage.service');
const storageCleanupService = require('../../src/services/storageCleanup.service');
const s3Provider = require('../../src/providers/s3');
const storageUploadRepository = require('../../src/repositories/storageUpload.repository');
const vehicleRepository = require('../../src/repositories/vehicle.repository');
const auditService = require('../../src/services/audit.service');
const pool = require('../../src/db/pool');
const { ValidationError, ForbiddenError, NotFoundError } = require('../../src/errors');

describe('Unit: StorageService & Cleanup', () => {
  const partnerId = '11111111-1111-1111-1111-111111111111';
  const otherPartnerId = '22222222-2222-2222-2222-222222222222';
  const vehicleId = '33333333-3333-3333-3333-333333333333';
  const uploadId = '44444444-4444-4444-4444-444444444444';

  beforeEach(() => {
    s3Provider.setMockPresigner(jest.fn().mockResolvedValue('https://mock-s3.amazonaws.com/test-bucket/url'));
    jest.spyOn(auditService, 'logEvent').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    s3Provider.resetS3Client();
  });

  describe('presignUpload', () => {
    it('creates presigned PUT URL and storage_uploads row for PROFILE_IMAGE', async () => {
      jest.spyOn(storageUploadRepository, 'createUpload').mockResolvedValueOnce({
        id: uploadId,
        partner_id: partnerId,
        entity_type: 'PROFILE_IMAGE',
        storage_key: `partners/${partnerId}/profile/abc.jpg`,
        content_type: 'image/jpeg',
        expected_size_bytes: 5242880,
        status: 'PENDING',
      });

      const res = await storageService.presignUpload({
        partnerId,
        input: {
          entityType: 'PROFILE_IMAGE',
          fileName: 'avatar.jpg',
          contentType: 'image/jpeg',
        },
      });

      expect(res.uploadId).toBe(uploadId);
      expect(res.uploadUrl).toBe('https://mock-s3.amazonaws.com/test-bucket/url');
      expect(res.storageKey).toMatch(new RegExp(`^partners/${partnerId}/profile/[0-9a-f-]+\\.jpg$`));
      expect(res.headers).toHaveProperty('x-amz-server-side-encryption', 'AES256');
      expect(auditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'STORAGE_UPLOAD_PRESIGNED',
          actorId: partnerId,
        }),
      );
    });

    it('creates presigned PUT URL for KYC_DOCUMENT with isolated path', async () => {
      jest.spyOn(storageUploadRepository, 'createUpload').mockResolvedValueOnce({
        id: uploadId,
        partner_id: partnerId,
        entity_type: 'KYC_DOCUMENT',
        document_type: 'AADHAAR',
        storage_key: `partners/${partnerId}/kyc/aadhaar/abc.pdf`,
        content_type: 'application/pdf',
        expected_size_bytes: 10485760,
        status: 'PENDING',
      });

      const res = await storageService.presignUpload({
        partnerId,
        input: {
          entityType: 'KYC_DOCUMENT',
          fileName: 'my_aadhaar.pdf',
          contentType: 'application/pdf',
          documentType: 'AADHAAR',
        },
      });

      expect(res.storageKey).toMatch(new RegExp(`^partners/${partnerId}/kyc/aadhaar/[0-9a-f-]+\\.pdf$`));
    });

    it('enforces vehicle ownership for VEHICLE_IMAGE (rejects non-owned vehicle with NotFoundError)', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValueOnce(null);

      await expect(
        storageService.presignUpload({
          partnerId,
          input: {
            entityType: 'VEHICLE_IMAGE',
            fileName: 'car_front.jpg',
            contentType: 'image/jpeg',
            vehicleId,
          },
        }),
      ).rejects.toThrow(NotFoundError);
    });

    it('allows VEHICLE_IMAGE when partner owns the vehicle', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValueOnce({
        id: vehicleId,
        partner_id: partnerId,
      });

      jest.spyOn(storageUploadRepository, 'createUpload').mockResolvedValueOnce({
        id: uploadId,
        partner_id: partnerId,
        entity_type: 'VEHICLE_IMAGE',
        entity_id: vehicleId,
        storage_key: `partners/${partnerId}/vehicles/${vehicleId}/images/abc.jpg`,
        content_type: 'image/jpeg',
        status: 'PENDING',
      });

      const res = await storageService.presignUpload({
        partnerId,
        input: {
          entityType: 'VEHICLE_IMAGE',
          fileName: 'car_front.jpg',
          contentType: 'image/jpeg',
          vehicleId,
        },
      });

      expect(res.storageKey).toMatch(new RegExp(`^partners/${partnerId}/vehicles/${vehicleId}/images/[0-9a-f-]+\\.jpg$`));
    });
  });

  describe('completeUpload', () => {
    it('throws NotFoundError if uploadId does not belong to partner (BOLA protection)', async () => {
      jest.spyOn(storageUploadRepository, 'findByIdAndPartnerId').mockResolvedValueOnce(null);

      await expect(
        storageService.completeUpload({
          partnerId,
          input: { uploadId },
        }),
      ).rejects.toThrow(NotFoundError);
    });

    it('returns existing record idempotently if upload is already COMPLETED', async () => {
      jest.spyOn(storageUploadRepository, 'findByIdAndPartnerId').mockResolvedValueOnce({
        id: uploadId,
        partner_id: partnerId,
        status: 'COMPLETED',
        entity_type: 'PROFILE_IMAGE',
        storage_key: `partners/${partnerId}/profile/abc.jpg`,
        actual_size_bytes: 2048,
      });

      const res = await storageService.completeUpload({
        partnerId,
        input: { uploadId },
      });

      expect(res.status).toBe('COMPLETED');
      expect(res.uploadId).toBe(uploadId);
      expect(res.sizeBytes).toBe(2048);
    });

    it('throws ValidationError if upload session has expired', async () => {
      jest.spyOn(storageUploadRepository, 'findByIdAndPartnerId').mockResolvedValueOnce({
        id: uploadId,
        partner_id: partnerId,
        status: 'PENDING',
        expires_at: new Date(Date.now() - 60000), // 1 minute in the past
      });
      jest.spyOn(storageUploadRepository, 'markStatus').mockResolvedValueOnce({});

      await expect(
        storageService.completeUpload({
          partnerId,
          input: { uploadId },
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError if file was not actually uploaded to S3 (HeadObject 404)', async () => {
      jest.spyOn(storageUploadRepository, 'findByIdAndPartnerId').mockResolvedValueOnce({
        id: uploadId,
        partner_id: partnerId,
        status: 'PENDING',
        storage_key: `partners/${partnerId}/profile/abc.jpg`,
        expires_at: new Date(Date.now() + 600000),
      });

      const notFoundErr = new Error('Object not found in S3');
      notFoundErr.notFound = true;
      notFoundErr.code = 'S3_OBJECT_NOT_FOUND';
      jest.spyOn(s3Provider, 'headObject').mockRejectedValueOnce(notFoundErr);

      await expect(
        storageService.completeUpload({
          partnerId,
          input: { uploadId },
        }),
      ).rejects.toThrow('File was not uploaded to storage');
    });

    it('rejects oversized file and deletes S3 object', async () => {
      jest.spyOn(storageUploadRepository, 'findByIdAndPartnerId').mockResolvedValueOnce({
        id: uploadId,
        partner_id: partnerId,
        status: 'PENDING',
        storage_key: `partners/${partnerId}/profile/abc.jpg`,
        expected_size_bytes: 5242880, // 5MB
        expires_at: new Date(Date.now() + 600000),
      });

      jest.spyOn(s3Provider, 'headObject').mockResolvedValueOnce({
        contentLength: 6000000, // 6MB (exceeds 5MB)
      });
      jest.spyOn(s3Provider, 'deleteObject').mockResolvedValueOnce({ success: true });
      jest.spyOn(storageUploadRepository, 'markStatus').mockResolvedValueOnce({});

      await expect(
        storageService.completeUpload({
          partnerId,
          input: { uploadId },
        }),
      ).rejects.toThrow('exceeds maximum permitted size');

      expect(s3Provider.deleteObject).toHaveBeenCalledWith({
        key: `partners/${partnerId}/profile/abc.jpg`,
      });
    });

    it('commits PROFILE_IMAGE upload, updates partner avatar, and logs audit event', async () => {
      jest.spyOn(storageUploadRepository, 'findByIdAndPartnerId').mockResolvedValueOnce({
        id: uploadId,
        partner_id: partnerId,
        status: 'PENDING',
        entity_type: 'PROFILE_IMAGE',
        storage_key: `partners/${partnerId}/profile/pic.jpg`,
        expected_size_bytes: 5242880,
        expires_at: new Date(Date.now() + 600000),
      });

      jest.spyOn(s3Provider, 'headObject').mockResolvedValueOnce({
        contentLength: 102400,
        contentType: 'image/jpeg',
      });

      jest.spyOn(pool, 'transaction').mockImplementationOnce(async (cb) => cb({}));

      jest.spyOn(storageUploadRepository, 'markCompleted').mockResolvedValueOnce({
        id: uploadId,
        entity_type: 'PROFILE_IMAGE',
        storage_key: `partners/${partnerId}/profile/pic.jpg`,
      });

      jest.spyOn(storageService.partnerRepository, 'updatePartner').mockResolvedValueOnce({});

      const res = await storageService.completeUpload({
        partnerId,
        input: { uploadId },
      });

      expect(res.status).toBe('COMPLETED');
      expect(res.sizeBytes).toBe(102400);
      expect(storageService.partnerRepository.updatePartner).toHaveBeenCalledWith(
        partnerId,
        { profileImageUrl: `partners/${partnerId}/profile/pic.jpg` },
        expect.anything(),
      );
      expect(auditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'STORAGE_UPLOAD_COMPLETED',
          actorId: partnerId,
        }),
      );
    });

    it('commits KYC_DOCUMENT upload with incremented version in partner_documents', async () => {
      jest.spyOn(storageUploadRepository, 'findByIdAndPartnerId').mockResolvedValueOnce({
        id: uploadId,
        partner_id: partnerId,
        status: 'PENDING',
        entity_type: 'KYC_DOCUMENT',
        document_type: 'PAN',
        storage_key: `partners/${partnerId}/kyc/pan/pan.pdf`,
        expected_size_bytes: 10485760,
        expires_at: new Date(Date.now() + 600000),
      });

      jest.spyOn(s3Provider, 'headObject').mockResolvedValueOnce({
        contentLength: 204800,
        contentType: 'application/pdf',
      });

      jest.spyOn(pool, 'transaction').mockImplementationOnce(async (cb) => cb({}));

      jest.spyOn(storageUploadRepository, 'markCompleted').mockResolvedValueOnce({
        id: uploadId,
        entity_type: 'KYC_DOCUMENT',
        storage_key: `partners/${partnerId}/kyc/pan/pan.pdf`,
      });

      jest.spyOn(storageService.documentRepository, 'findMaxVersion').mockResolvedValueOnce(1);
      jest.spyOn(storageService.documentRepository, 'createDocument').mockResolvedValueOnce({});

      const res = await storageService.completeUpload({
        partnerId,
        input: { uploadId },
      });

      expect(res.status).toBe('COMPLETED');
      expect(storageService.documentRepository.createDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          partnerId,
          documentType: 'PAN',
          version: 2,
          verificationStatus: 'PENDING',
        }),
        expect.anything(),
      );
    });

    it('commits VEHICLE_IMAGE upload into vehicle_images', async () => {
      jest.spyOn(storageUploadRepository, 'findByIdAndPartnerId').mockResolvedValueOnce({
        id: uploadId,
        partner_id: partnerId,
        entity_type: 'VEHICLE_IMAGE',
        entity_id: vehicleId,
        status: 'PENDING',
        storage_key: `partners/${partnerId}/vehicles/${vehicleId}/images/car.png`,
        expected_size_bytes: 10485760,
        expires_at: new Date(Date.now() + 600000),
      });

      jest.spyOn(s3Provider, 'headObject').mockResolvedValueOnce({
        contentLength: 500000,
        contentType: 'image/png',
      });

      jest.spyOn(pool, 'transaction').mockImplementationOnce(async (cb) => cb({}));

      jest.spyOn(storageUploadRepository, 'markCompleted').mockResolvedValueOnce({
        id: uploadId,
        entity_type: 'VEHICLE_IMAGE',
        storage_key: `partners/${partnerId}/vehicles/${vehicleId}/images/car.png`,
      });

      jest.spyOn(vehicleRepository, 'createVehicleImage').mockResolvedValueOnce({});

      const res = await storageService.completeUpload({
        partnerId,
        input: { uploadId },
      });

      expect(res.status).toBe('COMPLETED');
      expect(vehicleRepository.createVehicleImage).toHaveBeenCalledWith(
        expect.objectContaining({
          vehicleId,
          storageKey: `partners/${partnerId}/vehicles/${vehicleId}/images/car.png`,
        }),
        expect.anything(),
      );
    });

    it('commits VEHICLE_DOCUMENT upload into vehicle_documents with metadata', async () => {
      jest.spyOn(storageUploadRepository, 'findByIdAndPartnerId').mockResolvedValueOnce({
        id: uploadId,
        partner_id: partnerId,
        entity_type: 'VEHICLE_DOCUMENT',
        entity_id: vehicleId,
        document_type: 'RC',
        status: 'PENDING',
        storage_key: `partners/${partnerId}/vehicles/${vehicleId}/documents/rc/doc.pdf`,
        expected_size_bytes: 5242880,
        expires_at: new Date(Date.now() + 600000),
        metadata: JSON.stringify({
          documentNumber: 'MP04AB1234',
          documentName: 'RC Certificate',
          validTill: '2039-01-01',
        }),
      });

      jest.spyOn(s3Provider, 'headObject').mockResolvedValueOnce({
        contentLength: 204800,
        contentType: 'application/pdf',
      });

      jest.spyOn(pool, 'transaction').mockImplementationOnce(async (cb) => cb({}));

      jest.spyOn(storageUploadRepository, 'markCompleted').mockResolvedValueOnce({
        id: uploadId,
        entity_type: 'VEHICLE_DOCUMENT',
        storage_key: `partners/${partnerId}/vehicles/${vehicleId}/documents/rc/doc.pdf`,
      });

      jest.spyOn(vehicleRepository, 'findMaxDocumentVersion').mockResolvedValueOnce(0);
      jest.spyOn(vehicleRepository, 'createVehicleDocument').mockResolvedValueOnce({});

      const res = await storageService.completeUpload({
        partnerId,
        input: { uploadId },
      });

      expect(res.status).toBe('COMPLETED');
      expect(vehicleRepository.createVehicleDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          vehicleId,
          documentType: 'RC',
          documentNumber: 'MP04AB1234',
          documentName: 'RC Certificate',
          validTill: '2039-01-01',
          storageKey: `partners/${partnerId}/vehicles/${vehicleId}/documents/rc/doc.pdf`,
          verificationStatus: 'PENDING',
          isRequired: true,
          version: 1,
        }),
        expect.anything(),
      );
    });
  });

  describe('getAccessUrl', () => {
    it('rejects access if storageKey does not belong to authenticated partner (BOLA)', async () => {
      await expect(
        storageService.getAccessUrl({
          partnerId,
          input: {
            storageKey: `partners/${otherPartnerId}/profile/pic.jpg`,
          },
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('generates presigned download URL for own resources', async () => {
      jest.spyOn(s3Provider, 'createPresignedGetUrl').mockResolvedValueOnce({
        downloadUrl: 'https://mock-s3.amazonaws.com/test-bucket/download-url',
        expiresInSeconds: 300,
      });

      const res = await storageService.getAccessUrl({
        partnerId,
        input: {
          storageKey: `partners/${partnerId}/profile/pic.jpg`,
        },
      });

      expect(res.downloadUrl).toBe('https://mock-s3.amazonaws.com/test-bucket/download-url');
      expect(res.expiresInSeconds).toBe(300);
      expect(res.storageKey).toBe(`partners/${partnerId}/profile/pic.jpg`);
    });
  });

  describe('StorageCleanupService', () => {
    it('cleans up expired uploads and deletes orphan objects from S3', async () => {
      jest.spyOn(storageUploadRepository, 'findExpiredPendingUploads').mockResolvedValueOnce([
        {
          id: 'exp-1',
          partner_id: partnerId,
          storage_key: `partners/${partnerId}/profile/orphan1.jpg`,
        },
        {
          id: 'exp-2',
          partner_id: partnerId,
          storage_key: `partners/${partnerId}/profile/orphan2.jpg`,
        },
      ]);

      jest.spyOn(s3Provider, 'deleteObject').mockResolvedValue({ success: true });
      jest.spyOn(storageUploadRepository, 'markStatus').mockResolvedValue({});

      const result = await storageCleanupService.cleanupExpiredUploads();

      expect(result.cleanedCount).toBe(2);
      expect(s3Provider.deleteObject).toHaveBeenCalledTimes(2);
      expect(storageUploadRepository.markStatus).toHaveBeenCalledTimes(2);
    });
  });
});
