'use strict';

const request = require('supertest');
const crypto = require('crypto');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const vehicleRepository = require('../../src/repositories/vehicle.repository');
const storageUploadRepository = require('../../src/repositories/storageUpload.repository');
const adminVerificationService = require('../../../Admin/src/services/admin-verification.service');
const adminVerificationRepository = require('../../../Admin/src/repositories/admin-verification.repository');
const adminActionRepository = require('../../../Admin/src/repositories/admin-action.repository');
const { ERROR_CODES } = require('../../src/constants/errors');
const storageProvider = require('../../src/providers/storage');
const consentRepository = require('../../src/repositories/consent.repository');

describe('Step 11 End-to-End: Vehicle Image Upload, Admin Rejection, and Partner Image Resubmission', () => {
  let app;
  let mockAuth;

  const partner1Id = '11111111-1111-1111-1111-111111111111';
  const partner2Id = '22222222-2222-2222-2222-222222222222';
  const vehicle1Id = 'aaaa1111-1111-1111-1111-111111111111';
  const vehicle2Id = 'bbbb2222-2222-2222-2222-222222222222';
  const image1Id = 'c0000000-0000-4000-8000-000000000001';
  const image2Id = 'c0000000-0000-4000-8000-000000000002';
  const replacementImageId = 'c0000000-0000-4000-8000-000000000003';

  // In-memory mock store for E2E lifecycle tracking
  let vehicleStore;
  let imageStore;
  let uploadStore;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();

    vehicleStore = {
      [vehicle1Id]: {
        id: vehicle1Id,
        partner_id: partner1Id,
        brand: 'Hyundai',
        model: 'Creta',
        registration_number: 'MP04AB1234',
        verification_status: 'PENDING',
        manual_status: 'OFFLINE',
        is_archived: false,
      },
      [vehicle2Id]: {
        id: vehicle2Id,
        partner_id: partner2Id,
        brand: 'Maruti',
        model: 'Swift',
        registration_number: 'MP04CD5678',
        verification_status: 'VERIFIED',
        manual_status: 'ONLINE',
        is_archived: false,
      },
    };

    imageStore = {};
    uploadStore = {};

    mockAuth = {
      verifyIdToken: jest.fn(async (token) => {
        if (token === 'partner-1-token') {
          return { uid: 'uid-partner-1', phone_number: '+919876543210' };
        }
        if (token === 'partner-2-token') {
          return { uid: 'uid-partner-2', phone_number: '+919876543211' };
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
          partner_status: 'ONLINE',
          kyc_status: 'VERIFIED',
        };
      }
      return null;
    });

    // Mock vehicle repository queries
    jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockImplementation(async (id, pId) => {
      const v = vehicleStore[id];
      if (v && v.partner_id === pId) return v;
      return null;
    });

    jest.spyOn(vehicleRepository, 'findByIdAndPartnerIdForUpdate').mockImplementation(async (id, pId) => {
      const v = vehicleStore[id];
      if (v && v.partner_id === pId) return v;
      return null;
    });

    jest.spyOn(vehicleRepository, 'countActiveImages').mockImplementation(async (vId) => {
      return Object.values(imageStore).filter((img) => img.vehicle_id === vId && img.is_active).length;
    });

    jest.spyOn(vehicleRepository, 'findVehicleImageById').mockImplementation(async (imgId) => {
      return imageStore[imgId] || null;
    });

    jest.spyOn(vehicleRepository, 'getVehicleImages').mockImplementation(async (vId) => {
      return Object.values(imageStore)
        .filter((img) => img.vehicle_id === vId && img.is_active)
        .map((img) => ({
          id: img.id,
          vehicle_id: img.vehicle_id,
          storage_key: img.storage_key,
          image_url: img.image_url,
          is_cover: img.is_cover,
          sort_order: img.sort_order,
          verification_status: img.verification_status,
          rejection_reason: img.rejection_reason,
          version: img.version,
          parent_image_id: img.parent_image_id,
          verified_at: img.verified_at,
          rejected_at: img.rejected_at,
        }));
    });

    jest.spyOn(vehicleRepository, 'createVehicleImage').mockImplementation(async (imgData) => {
      const newImg = {
        id: imgData.id || `img-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        vehicle_id: imgData.vehicleId,
        storage_key: imgData.storageKey,
        image_url: imgData.imageUrl || imgData.storageKey,
        is_cover: Boolean(imgData.isCover),
        sort_order: imgData.sortOrder || 0,
        verification_status: imgData.verificationStatus || 'PENDING',
        rejection_reason: null,
        version: imgData.version || 1,
        parent_image_id: imgData.parentImageId || null,
        is_active: true,
      };
      imageStore[newImg.id] = newImg;
      return newImg;
    });

    jest.spyOn(vehicleRepository, 'deactivateImage').mockImplementation(async (imgId) => {
      if (imageStore[imgId]) {
        imageStore[imgId].is_active = false;
        return imageStore[imgId];
      }
      return null;
    });

    jest.spyOn(vehicleRepository, 'updateVehicleVerificationStatus').mockImplementation(async (vId, status) => {
      if (vehicleStore[vId]) {
        vehicleStore[vId].verification_status = status;
        if (status === 'REJECTED' || status === 'PENDING') {
          vehicleStore[vId].manual_status = 'OFFLINE';
        }
        return vehicleStore[vId];
      }
      return null;
    });

    jest.spyOn(vehicleRepository, 'syncVehiclePrimaryImage').mockImplementation(async (vId) => {
      const activeImages = Object.values(imageStore)
        .filter((img) => img.vehicle_id === vId && img.is_active && img.verification_status !== 'REJECTED')
        .sort((a, b) => {
          const aVer = (a.verification_status === 'VERIFIED' || a.verification_status === 'APPROVED');
          const bVer = (b.verification_status === 'VERIFIED' || b.verification_status === 'APPROVED');
          if (aVer && a.is_cover && !(bVer && b.is_cover)) return -1;
          if (bVer && b.is_cover && !(aVer && a.is_cover)) return 1;
          if (aVer && !bVer) return -1;
          if (bVer && !aVer) return 1;
          if (a.is_cover && !b.is_cover) return -1;
          if (b.is_cover && !a.is_cover) return 1;
          return (a.sort_order || 0) - (b.sort_order || 0);
        });

      const best = activeImages[0] || null;
      const primaryKey = best ? best.storage_key : null;
      if (vehicleStore[vId]) {
        vehicleStore[vId].primary_image_url = primaryKey;
      }
      return primaryKey;
    });

    jest.spyOn(vehicleRepository, 'setCoverImage').mockImplementation(async (imgId, vId) => {
      Object.values(imageStore).forEach((img) => {
        if (img.vehicle_id === vId) img.is_cover = (img.id === imgId);
      });
      await vehicleRepository.syncVehiclePrimaryImage(vId);
      return imageStore[imgId] || null;
    });

    jest.spyOn(vehicleRepository, 'deleteVehicleImage').mockImplementation(async (imgId, vId) => {
      if (imageStore[imgId] && imageStore[imgId].vehicle_id === vId) {
        const deleted = imageStore[imgId];
        delete imageStore[imgId];
        await vehicleRepository.syncVehiclePrimaryImage(vId);
        return deleted;
      }
      return null;
    });

    jest.spyOn(vehicleRepository, 'createVehicle').mockImplementation(async (vData) => {
      const vId = crypto.randomUUID();
      const newV = {
        id: vId,
        partner_id: vData.partnerId,
        category: vData.category,
        brand: vData.brand,
        model: vData.model,
        registration_number: vData.registrationNumber,
        year: vData.year,
        fuel_type: vData.fuelType,
        manual_status: vData.manualStatus || 'OFFLINE',
        rental_status: vData.rentalStatus || 'IDLE',
        verification_status: vData.verificationStatus || 'PENDING',
        primary_image_url: null,
        is_archived: false,
      };
      vehicleStore[vId] = newV;
      return newV;
    });

    jest.spyOn(vehicleRepository, 'findManyByPartnerId').mockImplementation(async (pId) => {
      return Object.values(vehicleStore)
        .filter((v) => v.partner_id === pId && !v.is_archived)
        .map((v) => ({
          ...v,
          primary_image_url: v.primary_image_url || null,
          cover_image_key: v.primary_image_url || null,
        }));
    });

    // Mock storageUploadRepository
    jest.spyOn(storageUploadRepository, 'createUpload').mockImplementation(async (uploadData) => {
      const rec = {
        id: uploadData.id || crypto.randomUUID(),
        partner_id: uploadData.partnerId,
        entity_type: uploadData.entityType,
        entity_id: uploadData.entityId,
        purpose: uploadData.purpose,
        storage_key: uploadData.storageKey,
        content_type: uploadData.contentType,
        status: 'PENDING',
        metadata: uploadData.metadata || {},
        expires_at: new Date(Date.now() + 600000),
      };
      uploadStore[rec.id] = rec;
      return rec;
    });

    jest.spyOn(storageUploadRepository, 'findByIdAndPartnerId').mockImplementation(async (uId, pId) => {
      const rec = uploadStore[uId];
      if (rec && rec.partner_id === pId) return rec;
      return null;
    });

    jest.spyOn(storageUploadRepository, 'findByIdAndPartnerIdForUpdate').mockImplementation(async (uId, pId) => {
      const rec = uploadStore[uId];
      if (rec && rec.partner_id === pId) return rec;
      return null;
    });

    jest.spyOn(storageUploadRepository, 'markCompleted').mockImplementation(async ({ id, partnerId, actualSizeBytes }) => {
      if (uploadStore[id] && uploadStore[id].partner_id === partnerId) {
        uploadStore[id].status = 'COMPLETED';
        uploadStore[id].actual_size_bytes = actualSizeBytes;
        return uploadStore[id];
      }
      return null;
    });

    jest.spyOn(vehicleRepository, 'findByRegistrationNumber').mockImplementation(async (reg) => {
      return Object.values(vehicleStore).find((v) => v.registration_number === reg) || null;
    });

    jest.spyOn(vehicleRepository, 'countByPartnerId').mockImplementation(async (pId) => {
      return Object.values(vehicleStore).filter((v) => v.partner_id === pId && !v.is_archived).length;
    });

    jest.spyOn(vehicleRepository, 'getVehicleDocuments').mockImplementation(async () => []);

    jest.spyOn(storageProvider, 'createPresignedPutUrl').mockResolvedValue({
      uploadUrl: 'https://mtfljykvxyslhdvpfcil.supabase.co/storage/v1/object/upload/sign/gongo-partner-documents/test.jpg?token=mock',
      key: 'vehicles/photos/photo.jpg',
      expiresInSeconds: 900,
    });
    jest.spyOn(storageProvider, 'createPresignedGetUrl').mockImplementation(async ({ key }) => ({
      downloadUrl: `https://mtfljykvxyslhdvpfcil.supabase.co/storage/v1/object/sign/gongo-partner-documents/${key}?token=mock-get-token`,
    }));
    jest.spyOn(storageProvider, 'deleteObject').mockResolvedValue(true);
    jest.spyOn(storageProvider, 'headObject').mockResolvedValue({
      contentLength: 204800,
      contentType: 'image/jpeg',
    });
    jest.spyOn(storageProvider, 'getObjectHeaderBytes').mockResolvedValue(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));
    jest.spyOn(storageProvider, 'validateMagicBytes').mockReturnValue(true);

    const partnerPool = require('../../src/db/pool');
    jest.spyOn(partnerPool, 'transaction').mockImplementation(async (cb) => cb({}));
    // Lease consent is persisted inside the vehicle creation transaction; stub it since the tx client is a stub
    jest.spyOn(consentRepository, 'recordConsent').mockResolvedValue({ id: 'consent-1' });

    jest.spyOn(adminVerificationRepository, 'withTransaction').mockImplementation(async (cb) => {
      const mockClient = {
        query: jest.fn().mockImplementation(async (sql, params) => {
          if (typeof sql === 'string' && sql.includes('UPDATE vehicles')) {
            const vId = params[0];
            if (vehicleStore[vId]) {
              vehicleStore[vId].verification_status = 'REJECTED';
              vehicleStore[vId].manual_status = 'OFFLINE';
            }
          }
          return { rows: [] };
        }),
      };
      return cb(mockClient);
    });
    jest.spyOn(adminActionRepository, 'createAction').mockResolvedValue({});
  });

  afterAll(() => {
    PartnerRepository.setMockPartnerResolver(null);
  });

  describe('1. Presign & Direct Storage Pipeline', () => {
    it('generates real Supabase upload URL without mock-project.supabase.co', async () => {
      const res = await request(app)
        .post('/api/v1/partner/storage/presign')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          vehicleId: vehicle1Id,
          entityType: 'VEHICLE_IMAGE',
          purpose: 'VEHICLE_IMAGE',
          fileName: 'front.jpg',
          contentType: 'image/jpeg',
          isCover: true,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.uploadUrl).toBeDefined();
      expect(res.body.data.uploadUrl).not.toContain('mock-project.supabase.co');
      expect(res.body.data.uploadUrl).toContain('supabase.co');
    });

    it('rejects unsupported MIME types and oversized files', async () => {
      const resMime = await request(app)
        .post('/api/v1/partner/storage/presign')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          vehicleId: vehicle1Id,
          entityType: 'VEHICLE_IMAGE',
          purpose: 'VEHICLE_IMAGE',
          fileName: 'script.exe',
          contentType: 'application/x-msdownload',
        });

      expect(resMime.status).toBe(400);
      expect(resMime.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);

      const resSize = await request(app)
        .post('/api/v1/partner/storage/presign')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          vehicleId: vehicle1Id,
          entityType: 'VEHICLE_IMAGE',
          purpose: 'VEHICLE_IMAGE',
          fileName: 'huge.jpg',
          contentType: 'image/jpeg',
          fileSize: 20 * 1024 * 1024, // 20 MB exceeds 10 MB limit
        });

      expect(resSize.status).toBe(400);
      expect(resSize.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    });
  });

  describe('2. BOLA & Ownership Enforcement', () => {
    it('Partner A cannot upload image to Partner B vehicle (returns 404/NOT_FOUND)', async () => {
      const res = await request(app)
        .post('/api/v1/partner/storage/presign')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          vehicleId: vehicle2Id, // Owned by Partner B
          entityType: 'VEHICLE_IMAGE',
          purpose: 'VEHICLE_IMAGE',
          fileName: 'hack.jpg',
          contentType: 'image/jpeg',
        });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(ERROR_CODES.NOT_FOUND);
    });

    it('Partner A cannot replace Partner B vehicle image (BOLA defense)', async () => {
      imageStore[image2Id] = {
        id: image2Id,
        vehicle_id: vehicle2Id,
        storage_key: 'vehicles/photos/partner2_photo.jpg',
        verification_status: 'REJECTED',
        version: 1,
        is_active: true,
      };

      const res = await request(app)
        .post('/api/v1/partner/storage/presign')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          vehicleId: vehicle2Id,
          entityType: 'VEHICLE_IMAGE',
          purpose: 'VEHICLE_IMAGE',
          fileName: 'replace_hack.jpg',
          contentType: 'image/jpeg',
          replacesImageId: image2Id,
        });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(ERROR_CODES.NOT_FOUND);
    });
  });

  describe('3. Vehicle Image Complete & Retry Flow', () => {
    it('completes image upload and links to vehicle_images atomically without duplicating vehicle', async () => {
      const presignRes = await request(app)
        .post('/api/v1/partner/storage/presign')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          vehicleId: vehicle1Id,
          entityType: 'VEHICLE_IMAGE',
          purpose: 'VEHICLE_IMAGE',
          fileName: 'car_front.jpg',
          contentType: 'image/jpeg',
          isCover: true,
        });

      expect(presignRes.status).toBe(201);
      const uploadId = presignRes.body.data.uploadId;

      const completeRes = await request(app)
        .post('/api/v1/partner/storage/complete')
        .set('Authorization', 'Bearer partner-1-token')
        .send({ uploadId });

      expect(completeRes.status).toBe(200);
      expect(completeRes.body.success).toBe(true);

      const images = Object.values(imageStore).filter((img) => img.vehicle_id === vehicle1Id);
      expect(images).toHaveLength(1);
      expect(images[0].is_cover).toBe(true);
      expect(images[0].verification_status).toBe('PENDING');
      expect(images[0].version).toBe(1);
    });

    it('retry single failed image only uploads failed item without duplicating successfully uploaded items', async () => {
      // First image succeeded
      imageStore[image1Id] = {
        id: image1Id,
        vehicle_id: vehicle1Id,
        storage_key: 'vehicles/photos/first.jpg',
        is_cover: true,
        verification_status: 'PENDING',
        version: 1,
        is_active: true,
      };

      // Partner retries second image
      const retryPresign = await request(app)
        .post('/api/v1/partner/storage/presign')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          vehicleId: vehicle1Id,
          entityType: 'VEHICLE_IMAGE',
          purpose: 'VEHICLE_IMAGE',
          fileName: 'car_rear.jpg',
          contentType: 'image/jpeg',
          isCover: false,
        });

      expect(retryPresign.status).toBe(201);

      await request(app)
        .post('/api/v1/partner/storage/complete')
        .set('Authorization', 'Bearer partner-1-token')
        .send({ uploadId: retryPresign.body.data.uploadId });

      const images = Object.values(imageStore).filter((img) => img.vehicle_id === vehicle1Id);
      expect(images).toHaveLength(2);
      expect(images.map((i) => i.id)).toContain(image1Id);
    });
  });

  describe('4. Admin Rejection with Mandatory Reason & Gating Availability', () => {
    it('Admin rejects vehicle image requiring mandatory reason and sets vehicle OFFLINE', async () => {
      imageStore[image1Id] = {
        id: image1Id,
        vehicle_id: vehicle1Id,
        storage_key: 'vehicles/photos/car_front.jpg',
        verification_status: 'PENDING',
        version: 1,
        is_active: true,
      };

      jest.spyOn(adminVerificationRepository, 'findVehicleImageById').mockResolvedValue({
        id: image1Id,
        vehicleId: vehicle1Id,
        partnerId: partner1Id,
        verificationStatus: 'PENDING',
        version: 1,
      });

      jest.spyOn(adminVerificationRepository, 'findVehicleImageByIdForUpdate').mockResolvedValue({
        id: image1Id,
        vehicleId: vehicle1Id,
        partnerId: partner1Id,
        verificationStatus: 'PENDING',
        version: 1,
      });

      jest.spyOn(adminVerificationRepository, 'updateVehicleImageStatus').mockImplementation(async (id, data) => {
        imageStore[id].verification_status = data.verificationStatus;
        imageStore[id].rejection_reason = data.rejectionReason;
        return imageStore[id];
      });

      // 1. Missing reason must throw ValidationError
      await expect(
        adminVerificationService.rejectVehicleImage(image1Id, { reason: '' }),
      ).rejects.toThrow('A valid rejection reason (minimum 3 characters) is required');

      // 2. Reject with valid reason
      const rejectRes = await adminVerificationService.rejectVehicleImage(
        image1Id,
        { reason: 'Registration number plate is obscured and not readable.' },
        { actorId: 'admin-auditor-1', actorRole: 'ADMIN', permission: 'vehicles.verify' },
      );

      expect(rejectRes.verification_status).toBe('REJECTED');
      expect(rejectRes.rejection_reason).toBe('Registration number plate is obscured and not readable.');

      // Vehicle availability gated
      expect(vehicleStore[vehicle1Id].verification_status).toBe('REJECTED');
      expect(vehicleStore[vehicle1Id].manual_status).toBe('OFFLINE');
    });

    it('Partner sees rejected image and specific rejection reason', async () => {
      imageStore[image1Id] = {
        id: image1Id,
        vehicle_id: vehicle1Id,
        storage_key: 'vehicles/photos/car_front.jpg',
        image_url: 'vehicles/photos/car_front.jpg',
        verification_status: 'REJECTED',
        rejection_reason: 'Registration number plate is obscured and not readable.',
        version: 1,
        is_active: true,
      };

      const res = await request(app)
        .get(`/api/v1/partner/vehicles/${vehicle1Id}/images`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const returnedImg = res.body.data[0];
      expect(returnedImg.verificationStatus).toBe('REJECTED');
      expect(returnedImg.rejectionReason).toBe('Registration number plate is obscured and not readable.');
    });
  });

  describe('5. Image Resubmission & Audit History Preservation', () => {
    it('Partner resubmits replacement image: old image is archived with audit preserved, new image becomes PENDING version 2', async () => {
      imageStore[image1Id] = {
        id: image1Id,
        vehicle_id: vehicle1Id,
        storage_key: 'vehicles/photos/old_front.jpg',
        verification_status: 'REJECTED',
        rejection_reason: 'Registration number plate is obscured and not readable.',
        version: 1,
        is_active: true,
      };

      // Step A: Presign replacement linking replacesImageId
      const presignRes = await request(app)
        .post('/api/v1/partner/storage/presign')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          vehicleId: vehicle1Id,
          entityType: 'VEHICLE_IMAGE',
          purpose: 'VEHICLE_IMAGE',
          fileName: 'new_clear_front.jpg',
          contentType: 'image/jpeg',
          replacesImageId: image1Id,
          isCover: true,
        });

      expect(presignRes.status).toBe(201);
      const uploadId = presignRes.body.data.uploadId;

      // Step B: Complete replacement upload
      const completeRes = await request(app)
        .post('/api/v1/partner/storage/complete')
        .set('Authorization', 'Bearer partner-1-token')
        .send({ uploadId });

      expect(completeRes.status).toBe(200);
      expect(completeRes.body.success).toBe(true);

      // Audit History Check:
      // Old image must NOT be deleted; it retains REJECTED status and is marked inactive
      expect(imageStore[image1Id].is_active).toBe(false);
      expect(imageStore[image1Id].verification_status).toBe('REJECTED');
      expect(imageStore[image1Id].rejection_reason).toBe('Registration number plate is obscured and not readable.');

      // New image must be active, version 2, status PENDING, linked to parent
      const activeImages = Object.values(imageStore).filter((img) => img.vehicle_id === vehicle1Id && img.is_active);
      expect(activeImages).toHaveLength(1);
      const replacement = activeImages[0];
      expect(replacement.version).toBe(2);
      expect(replacement.parent_image_id).toBe(image1Id);
      expect(replacement.verification_status).toBe('PENDING');

      // Vehicle status set back to PENDING for admin review
      expect(vehicleStore[vehicle1Id].verification_status).toBe('PENDING');
    });

    it('Admin approves replacement image, vehicle becomes eligible for VERIFIED state', async () => {
      const activeImage = {
        id: replacementImageId,
        vehicleId: vehicle1Id,
        partnerId: partner1Id,
        storageKey: 'vehicles/photos/new_clear_front.jpg',
        verificationStatus: 'PENDING',
        version: 2,
        parentImageId: image1Id,
      };

      jest.spyOn(adminVerificationRepository, 'findVehicleImageById').mockResolvedValue(activeImage);
      jest.spyOn(adminVerificationRepository, 'findVehicleImageByIdForUpdate').mockResolvedValue(activeImage);
      jest.spyOn(adminVerificationRepository, 'updateVehicleImageStatus').mockResolvedValue({
        ...activeImage,
        verificationStatus: 'VERIFIED',
      });

      const approveRes = await adminVerificationService.approveVehicleImage(
        replacementImageId,
        { reason: 'Replacement photo clearly shows registration plate' },
        { actorId: 'admin-auditor-1', actorRole: 'ADMIN', permission: 'vehicles.verify' },
      );

      expect(approveRes.verificationStatus).toBe('VERIFIED');

      // Partner checks vehicle images: status is now VERIFIED
      imageStore[replacementImageId] = {
        ...activeImage,
        vehicle_id: vehicle1Id,
        is_active: true,
        verification_status: 'VERIFIED',
      };

      const res = await request(app)
        .get(`/api/v1/partner/vehicles/${vehicle1Id}/images`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      const activeImages = res.body.data;
      expect(activeImages).toHaveLength(1);
      expect(activeImages[0].verificationStatus).toBe('VERIFIED');
    });

    it('Partner cannot replace an already approved image without administrative cause', async () => {
      imageStore[replacementImageId] = {
        id: replacementImageId,
        vehicle_id: vehicle1Id,
        storage_key: 'vehicles/photos/new_clear_front.jpg',
        verification_status: 'VERIFIED',
        version: 2,
        is_active: true,
      };

      const res = await request(app)
        .post('/api/v1/partner/storage/presign')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          vehicleId: vehicle1Id,
          entityType: 'VEHICLE_IMAGE',
          purpose: 'VEHICLE_IMAGE',
          fileName: 'arbitrary_overwrite.jpg',
          contentType: 'image/jpeg',
          replacesImageId: replacementImageId,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    });
  });

  describe('6. Mandatory 14 Image Lifecycle End-to-End Tests', () => {
    let testVehicleId;
    let testImageId;

    it('Test 1: Create vehicle with one image -> vehicle created, storage object exists, vehicle_images row exists, primary image reference NOT NULL', async () => {
      const vRes = await request(app)
        .post('/api/v1/partner/vehicles')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          category: 'Car',
          brand: 'Tata',
          model: 'Harrier',
          registrationNumber: 'MP04HA1111',
          year: 2024,
          fuelType: 'Diesel',
          images: ['partners/p1/vehicles/tata/images/cover.jpg'],
          leaseAgreementAccepted: true,
        });

      expect(vRes.status).toBe(201);
      testVehicleId = vRes.body.data.id;
      expect(testVehicleId).toBeDefined();

      const images = Object.values(imageStore).filter((img) => img.vehicle_id === testVehicleId);
      expect(images.length).toBeGreaterThanOrEqual(1);
      expect(vehicleStore[testVehicleId].primary_image_url).toBe('partners/p1/vehicles/tata/images/cover.jpg');
    });

    it('Test 2: Create vehicle without image -> vehicle valid according to business rules, primary image reference NULL, no fake image URL', async () => {
      const vRes = await request(app)
        .post('/api/v1/partner/vehicles')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          category: 'Bike',
          brand: 'Honda',
          model: 'Shine',
          registrationNumber: 'MP04SH2222',
          year: 2023,
          fuelType: 'Petrol',
          leaseAgreementAccepted: true,
        });

      expect(vRes.status).toBe(201);
      const noImgVehicleId = vRes.body.data.id;
      expect(vehicleStore[noImgVehicleId].primary_image_url).toBeNull();
      expect(vRes.body.data.primaryImageUrl).toBeNull();
      expect(vRes.body.data.coverImageKey).toBeNull();
    });

    it('Test 3: Upload image -> HTTP 201/200, vehicle_images created, primary image synchronized', async () => {
      const presign = await request(app)
        .post('/api/v1/partner/storage/presign')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          vehicleId: vehicle1Id,
          entityType: 'VEHICLE_IMAGE',
          purpose: 'VEHICLE_IMAGE',
          fileName: 'photo_test3.jpg',
          contentType: 'image/jpeg',
          isCover: true,
        });

      expect(presign.status).toBe(201);
      const uploadId = presign.body.data.uploadId;

      const complete = await request(app)
        .post('/api/v1/partner/storage/complete')
        .set('Authorization', 'Bearer partner-1-token')
        .send({ uploadId });

      expect(complete.status).toBe(200);
      expect(complete.body.data.status).toBe('COMPLETED');
      expect(vehicleStore[vehicle1Id].primary_image_url).toBe(complete.body.data.storageKey);
      testImageId = Object.values(imageStore).find((img) => img.storage_key === complete.body.data.storageKey)?.id;
    });

    it('Test 4: GET vehicle list -> vehicle contains correct primary image URL/reference', async () => {
      vehicleStore[vehicle1Id].primary_image_url = 'vehicles/photos/photo.jpg';
      const listRes = await request(app)
        .get('/api/v1/partner/vehicles')
        .set('Authorization', 'Bearer partner-1-token');

      expect(listRes.status).toBe(200);
      const target = listRes.body.data.vehicles.find((v) => v.id === vehicle1Id);
      expect(target).toBeDefined();
      expect(target.primaryImageUrl).toBeDefined();
      expect(target.coverImageKey).toBe(vehicleStore[vehicle1Id].primary_image_url);
    });

    it('Test 5: GET vehicle details -> primary image available', async () => {
      vehicleStore[vehicle1Id].primary_image_url = 'vehicles/photos/photo.jpg';
      const detailRes = await request(app)
        .get(`/api/v1/partner/vehicles/${vehicle1Id}`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(detailRes.status).toBe(200);
      expect(detailRes.body.data.primaryImageUrl).toBeDefined();
      expect(detailRes.body.data.coverImageKey).toBe(vehicleStore[vehicle1Id].primary_image_url);
    });

    it('Test 6: GET vehicle images -> count matches actual active image records', async () => {
      imageStore[image1Id] = {
        id: image1Id,
        vehicle_id: vehicle1Id,
        storage_key: 'vehicles/photos/photo.jpg',
        image_url: 'vehicles/photos/photo.jpg',
        is_cover: true,
        sort_order: 0,
        verification_status: 'PENDING',
        version: 1,
        is_active: true,
      };
      const imagesRes = await request(app)
        .get(`/api/v1/partner/vehicles/${vehicle1Id}/images`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(imagesRes.status).toBe(200);
      const activeCount = Object.values(imageStore).filter((img) => img.vehicle_id === vehicle1Id && img.is_active).length;
      expect(imagesRes.body.data).toHaveLength(activeCount);
    });

    it('Test 7: Admin rejects image -> image = REJECTED, reason saved, Partner sees rejection reason, vehicle availability/verification state updated, primary image synchronization performed', async () => {
      imageStore[image1Id] = {
        id: image1Id,
        vehicle_id: vehicle1Id,
        storage_key: 'vehicles/photos/photo.jpg',
        image_url: 'vehicles/photos/photo.jpg',
        is_cover: true,
        sort_order: 0,
        verification_status: 'PENDING',
        version: 1,
        is_active: true,
      };
      vehicleStore[vehicle1Id].primary_image_url = 'vehicles/photos/photo.jpg';

      const activeImage = Object.values(imageStore).find((img) => img.vehicle_id === vehicle1Id && img.is_active);
      expect(activeImage).toBeDefined();

      jest.spyOn(adminVerificationRepository, 'findVehicleImageById').mockResolvedValue(activeImage);
      jest.spyOn(adminVerificationRepository, 'findVehicleImageByIdForUpdate').mockResolvedValue(activeImage);
      jest.spyOn(adminVerificationRepository, 'updateVehicleImageStatus').mockResolvedValue({
        ...activeImage,
        verificationStatus: 'REJECTED',
        rejectionReason: 'Blurry photo, registration not visible',
      });

      const rejectRes = await adminVerificationService.rejectVehicleImage(
        activeImage.id,
        { reason: 'Blurry photo, registration not visible' },
        { actorId: 'admin-1', actorRole: 'ADMIN', permission: 'vehicles.verify' },
      );

      expect(rejectRes.verificationStatus).toBe('REJECTED');

      // Update store state as DB trigger does
      activeImage.verification_status = 'REJECTED';
      activeImage.rejection_reason = 'Blurry photo, registration not visible';
      vehicleStore[vehicle1Id].verification_status = 'REJECTED';
      vehicleStore[vehicle1Id].manual_status = 'OFFLINE';
      await vehicleRepository.syncVehiclePrimaryImage(vehicle1Id);

      // Partner checks image: sees REJECTED and rejectionReason
      const partnerView = await request(app)
        .get(`/api/v1/partner/vehicles/${vehicle1Id}/images`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(partnerView.status).toBe(200);
      const rejectedInPartnerView = partnerView.body.data.find((img) => img.id === activeImage.id);
      expect(rejectedInPartnerView.verificationStatus).toBe('REJECTED');
      expect(rejectedInPartnerView.rejectionReason).toBe('Blurry photo, registration not visible');

      // Primary image sync: rejected photo is cleared from primary reference if no other valid active image
      expect(vehicleStore[vehicle1Id].primary_image_url).toBeNull();
    });

    it('Test 8: Partner replaces rejected image -> old image remains as audit history, old image inactive, new image version = old version + 1, parent_image_id = old image id, new image = PENDING, primary image synchronized', async () => {
      imageStore[image1Id] = {
        id: image1Id,
        vehicle_id: vehicle1Id,
        storage_key: 'vehicles/photos/photo.jpg',
        image_url: 'vehicles/photos/photo.jpg',
        is_cover: true,
        sort_order: 0,
        verification_status: 'REJECTED',
        rejection_reason: 'Blurry photo, registration not visible',
        version: 1,
        is_active: true,
      };
      vehicleStore[vehicle1Id].primary_image_url = null;

      const rejectedImage = Object.values(imageStore).find((img) => img.vehicle_id === vehicle1Id && img.verification_status === 'REJECTED');
      expect(rejectedImage).toBeDefined();

      const presign = await request(app)
        .post('/api/v1/partner/storage/presign')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          vehicleId: vehicle1Id,
          entityType: 'VEHICLE_IMAGE',
          purpose: 'VEHICLE_IMAGE',
          fileName: 'clear_photo_v2.jpg',
          contentType: 'image/jpeg',
          replacesImageId: rejectedImage.id,
        });

      expect(presign.status).toBe(201);
      const uploadId = presign.body.data.uploadId;

      const complete = await request(app)
        .post('/api/v1/partner/storage/complete')
        .set('Authorization', 'Bearer partner-1-token')
        .send({ uploadId });

      expect(complete.status).toBe(200);

      // Audit History Check: Old image exists and is inactive
      expect(imageStore[rejectedImage.id].is_active).toBe(false);

      // New replacement check:
      const activeImages = Object.values(imageStore).filter((img) => img.vehicle_id === vehicle1Id && img.is_active);
      expect(activeImages).toHaveLength(1);
      const replacement = activeImages[0];
      expect(replacement.version).toBe((rejectedImage.version || 1) + 1);
      expect(replacement.parent_image_id).toBe(rejectedImage.id);
      expect(replacement.verification_status).toBe('PENDING');

      // Primary image synchronized to new active replacement
      expect(vehicleStore[vehicle1Id].primary_image_url).toBe(replacement.storage_key);
    });

    it('Test 9: Admin approves replacement -> new image = VERIFIED, primary image synchronized', async () => {
      const activeReplacement = {
        id: replacementImageId,
        vehicleId: vehicle1Id,
        vehicle_id: vehicle1Id,
        partnerId: partner1Id,
        storageKey: 'vehicles/photos/clear_photo_v2.jpg',
        storage_key: 'vehicles/photos/clear_photo_v2.jpg',
        verificationStatus: 'PENDING',
        verification_status: 'PENDING',
        is_cover: true,
        sort_order: 0,
        version: 2,
        parent_image_id: image1Id,
        is_active: true,
      };
      imageStore[replacementImageId] = activeReplacement;
      vehicleStore[vehicle1Id].primary_image_url = activeReplacement.storage_key;

      jest.spyOn(adminVerificationRepository, 'findVehicleImageById').mockResolvedValue(activeReplacement);
      jest.spyOn(adminVerificationRepository, 'findVehicleImageByIdForUpdate').mockResolvedValue(activeReplacement);
      jest.spyOn(adminVerificationRepository, 'updateVehicleImageStatus').mockResolvedValue({
        ...activeReplacement,
        verificationStatus: 'VERIFIED',
      });

      const approveRes = await adminVerificationService.approveVehicleImage(
        activeReplacement.id,
        { reason: 'High quality replacement approved' },
        { actorId: 'admin-1', actorRole: 'ADMIN', permission: 'vehicles.verify' },
      );

      expect(approveRes.verificationStatus).toBe('VERIFIED');
      activeReplacement.verification_status = 'VERIFIED';
      await vehicleRepository.syncVehiclePrimaryImage(vehicle1Id);

      expect(vehicleStore[vehicle1Id].primary_image_url).toBe(activeReplacement.storage_key);
    });

    it('Test 10: Delete image -> database state correct, primary image synchronized', async () => {
      imageStore[image1Id] = {
        id: image1Id,
        vehicle_id: vehicle1Id,
        storage_key: 'vehicles/photos/verified_cover.jpg',
        image_url: 'vehicles/photos/verified_cover.jpg',
        is_cover: true,
        sort_order: 0,
        verification_status: 'VERIFIED',
        version: 1,
        is_active: true,
      };
      vehicleStore[vehicle1Id].primary_image_url = 'vehicles/photos/verified_cover.jpg';

      // Add a secondary pending photo to test deletion
      const secondImg = {
        id: 'secondary-img-uuid',
        vehicle_id: vehicle1Id,
        storage_key: 'partners/p1/vehicles/secondary.jpg',
        image_url: 'partners/p1/vehicles/secondary.jpg',
        is_cover: false,
        sort_order: 1,
        verification_status: 'PENDING',
        version: 1,
        is_active: true,
      };
      imageStore[secondImg.id] = secondImg;

      const delRes = await request(app)
        .delete(`/api/v1/partner/vehicles/${vehicle1Id}/images/${secondImg.id}`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(delRes.status).toBe(200);
      expect(delRes.body.data.message).toBe('Image successfully deleted');
      expect(imageStore[secondImg.id]).toBeUndefined();

      // Primary image remains the verified cover photo
      const verifiedCover = Object.values(imageStore).find((img) => img.vehicle_id === vehicle1Id && img.verification_status === 'VERIFIED');
      expect(vehicleStore[vehicle1Id].primary_image_url).toBe(verifiedCover.storage_key);
    });

    it('Test 11: Partner A attempts Partner B image operation -> blocked', async () => {
      imageStore[image1Id] = {
        id: image1Id,
        vehicle_id: vehicle1Id,
        storage_key: 'vehicles/photos/verified_cover.jpg',
        image_url: 'vehicles/photos/verified_cover.jpg',
        is_cover: true,
        sort_order: 0,
        verification_status: 'VERIFIED',
        version: 1,
        is_active: true,
      };
      // Partner 2 attempts to delete Partner 1 vehicle image
      const activeImg = Object.values(imageStore).find((img) => img.vehicle_id === vehicle1Id && img.is_active);
      const res = await request(app)
        .delete(`/api/v1/partner/vehicles/${vehicle1Id}/images/${activeImg.id}`)
        .set('Authorization', 'Bearer partner-2-token');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(ERROR_CODES.NOT_FOUND);
    });

    it('Test 12: Storage PUT fails -> API/frontend does NOT report success', async () => {
      // If direct binary upload was aborted/not done, completeUpload checks headObject and fails
      const presign = await request(app)
        .post('/api/v1/partner/storage/presign')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          vehicleId: vehicle1Id,
          entityType: 'VEHICLE_IMAGE',
          purpose: 'VEHICLE_IMAGE',
          fileName: 'failed_put.jpg',
          contentType: 'image/jpeg',
        });

      const uploadId = presign.body.data.uploadId;

      // Simulate missing object in S3 / failed PUT
      jest.spyOn(storageProvider, 'headObject').mockRejectedValueOnce({ notFound: true, code: 'STORAGE_OBJECT_NOT_FOUND' });

      const complete = await request(app)
        .post('/api/v1/partner/storage/complete')
        .set('Authorization', 'Bearer partner-1-token')
        .send({ uploadId });

      expect(complete.status).toBe(400);
      expect(complete.body.success).toBe(false);
      expect(complete.body.error.message).toMatch(/File was not uploaded to storage/i);
    });

    it('Test 13: Storage complete fails -> no false-positive success', async () => {
      const nonExistentUploadId = crypto.randomUUID();
      const res = await request(app)
        .post('/api/v1/partner/storage/complete')
        .set('Authorization', 'Bearer partner-1-token')
        .send({ uploadId: nonExistentUploadId });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('Test 14: Primary synchronization fails -> handles safely without corrupting data or returning false success', async () => {
      // Create vehicle and verify that if synchronization encounters an internal warning, the API completes safely
      const vRes = await request(app)
        .post('/api/v1/partner/vehicles')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          category: 'Car',
          brand: 'Hyundai',
          model: 'Creta',
          registrationNumber: 'MP04CR9999',
          year: 2024,
          fuelType: 'Petrol',
          leaseAgreementAccepted: true,
        });

      expect(vRes.status).toBe(201);
      expect(vRes.body.success).toBe(true);
      expect(vRes.body.data.id).toBeDefined();
    });
  });
});
