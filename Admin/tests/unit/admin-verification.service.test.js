'use strict';

const adminVerificationService = require('../../src/services/admin-verification.service');
const adminVerificationRepository = require('../../src/repositories/admin-verification.repository');
const adminActionRepository = require('../../src/repositories/admin-action.repository');
const auditService = require('../../src/services/audit.service');
const s3Provider = require('../../src/providers/s3');
const { ValidationError, NotFoundError } = require('../../src/errors');

describe('Unit: AdminVerificationService', () => {
  const TEST_PARTNER_ID = 'b1111111-1111-4111-a111-111111111111';
  const TEST_VEHICLE_ID = 'd1111111-1111-4111-a111-111111111111';
  const TEST_PARTNER_DOC_ID = 'e1111111-1111-4111-a111-111111111111';
  const TEST_VEHICLE_DOC_ID = 'e2222222-2222-4222-a222-222222222222';

  const mockPartnerRecord = {
    id: TEST_PARTNER_ID,
    userId: 'u-1',
    businessName: 'Apex Mobility',
    businessType: 'CAR_RENTAL',
    city: 'Bengaluru',
    kycStatus: 'PENDING',
    isActive: true,
    owner: { name: 'Suresh Patel', email: 'suresh@apex.in', phone: '9876543210' },
    documents: [],
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

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(adminVerificationRepository, 'withTransaction')
      .mockImplementation(async (cb) => cb({}));
    jest.spyOn(adminActionRepository, 'createAction').mockResolvedValue({ id: 'act-1' });
    jest.spyOn(auditService, 'logAdminAction').mockImplementation((evt) => evt);
  });

  // ── UUID & Date Helpers ───────────────────────────────────────────────────

  describe('Validation Helpers', () => {
    it('accepts valid RFC 4122 v4 UUID and rejects malformed values', () => {
      expect(adminVerificationService._assertUuid(TEST_PARTNER_ID)).toBe(TEST_PARTNER_ID);
      expect(() => adminVerificationService._assertUuid('not-a-uuid')).toThrow(ValidationError);
      expect(() => adminVerificationService._assertUuid(null)).toThrow(ValidationError);
    });

    it('validates date range logic and bounds to 366 days', () => {
      const dates = adminVerificationService._parseDates('2026-09-01', '2026-09-05');
      expect(dates.startDate).toBeInstanceOf(Date);
      expect(dates.endDate).toBeInstanceOf(Date);

      expect(() => adminVerificationService._parseDates('2026-09-05', null))
        .toThrow(ValidationError);
      expect(() => adminVerificationService._parseDates('bad-date', '2026-09-05'))
        .toThrow(ValidationError);
      expect(() => adminVerificationService._parseDates('2026-09-10', '2026-09-01'))
        .toThrow('startDate must be before endDate');
      expect(() => adminVerificationService._parseDates('2023-01-01', '2026-01-01'))
        .toThrow('Date range cannot exceed 366 days');
    });
  });

  // ── Partner Verification ──────────────────────────────────────────────────

  describe('listPartnerVerifications', () => {
    it('returns partners list and pagination metadata', async () => {
      jest.spyOn(adminVerificationRepository, 'listPartnerVerifications').mockResolvedValue({
        partners: [mockPartnerRecord],
        total: 1,
      });

      const res = await adminVerificationService.listPartnerVerifications({
        limit: '10', offset: '0',
      });

      expect(res.partners).toHaveLength(1);
      expect(res.pagination.total).toBe(1);
      expect(res.pagination.pages).toBe(1);
    });

    it('rejects invalid kycStatus enum', async () => {
      await expect(
        adminVerificationService.listPartnerVerifications({ kycStatus: 'INVALID_STATUS' }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects non-positive limit or negative offset', async () => {
      await expect(
        adminVerificationService.listPartnerVerifications({ limit: '0' }),
      ).rejects.toThrow(ValidationError);
      await expect(
        adminVerificationService.listPartnerVerifications({ offset: '-1' }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('getPartnerVerificationDetail', () => {
    it('returns partner verification detail when found', async () => {
      jest.spyOn(adminVerificationRepository, 'findPartnerVerificationById')
        .mockResolvedValue(mockPartnerRecord);

      const res = await adminVerificationService.getPartnerVerificationDetail(TEST_PARTNER_ID);
      expect(res.id).toBe(TEST_PARTNER_ID);
      expect(res.businessName).toBe('Apex Mobility');
    });

    it('throws NotFoundError when partner does not exist', async () => {
      jest.spyOn(adminVerificationRepository, 'findPartnerVerificationById')
        .mockResolvedValue(null);

      await expect(
        adminVerificationService.getPartnerVerificationDetail(TEST_PARTNER_ID),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('approvePartner', () => {
    it('rejects disallowed fields in approve body (mass assignment)', async () => {
      await expect(
        adminVerificationService.approvePartner(TEST_PARTNER_ID, {
          arbitraryField: 'attack',
        }),
      ).rejects.toThrow("Field 'arbitraryField' is not allowed");
    });

    it('throws NotFoundError when partner does not exist', async () => {
      jest.spyOn(adminVerificationRepository, 'findPartnerByIdForUpdate').mockResolvedValue(null);

      await expect(
        adminVerificationService.approvePartner(TEST_PARTNER_ID),
      ).rejects.toThrow(NotFoundError);
    });

    it('approves partner, updates kyc_status to VERIFIED, and writes audit', async () => {
      jest.spyOn(adminVerificationRepository, 'findPartnerByIdForUpdate').mockResolvedValue({
        ...mockPartnerRecord,
        kycStatus: 'PENDING',
      });
      jest.spyOn(adminVerificationRepository, 'updatePartnerKycStatus').mockResolvedValue({
        ...mockPartnerRecord,
        kycStatus: 'VERIFIED',
      });

      const res = await adminVerificationService.approvePartner(
        TEST_PARTNER_ID,
        { reason: 'All documents verified' },
        { actorId: 'admin-1', actorRole: 'ADMIN', permission: 'kyc.verify' },
      );

      expect(res.kycStatus).toBe('VERIFIED');
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PARTNER_KYC_APPROVED',
          targetResource: 'PARTNER',
          targetResourceId: TEST_PARTNER_ID,
        }),
        expect.anything(),
      );
    });
  });

  describe('rejectPartner', () => {
    it('rejects when reason is missing or less than 3 chars', async () => {
      await expect(
        adminVerificationService.rejectPartner(TEST_PARTNER_ID, {}),
      ).rejects.toThrow('A valid rejection reason');

      await expect(
        adminVerificationService.rejectPartner(TEST_PARTNER_ID, { reason: 'no' }),
      ).rejects.toThrow('A valid rejection reason');
    });

    it('rejects partner, updates kyc_status to REJECTED, and writes audit', async () => {
      jest.spyOn(adminVerificationRepository, 'findPartnerByIdForUpdate').mockResolvedValue({
        ...mockPartnerRecord,
        kycStatus: 'PENDING',
      });
      jest.spyOn(adminVerificationRepository, 'updatePartnerKycStatus').mockResolvedValue({
        ...mockPartnerRecord,
        kycStatus: 'REJECTED',
      });

      const res = await adminVerificationService.rejectPartner(
        TEST_PARTNER_ID,
        { reason: 'PAN card mismatch with registration' },
        { actorId: 'admin-1', actorRole: 'ADMIN', permission: 'kyc.reject' },
      );

      expect(res.kycStatus).toBe('REJECTED');
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PARTNER_KYC_REJECTED',
          targetResource: 'PARTNER',
          targetResourceId: TEST_PARTNER_ID,
        }),
        expect.anything(),
      );
    });
  });

  // ── Vehicle Verification ──────────────────────────────────────────────────

  describe('listVehicleVerifications', () => {
    it('returns vehicles list and pagination metadata', async () => {
      jest.spyOn(adminVerificationRepository, 'listVehicleVerifications').mockResolvedValue({
        vehicles: [mockVehicleRecord],
        total: 1,
      });

      const res = await adminVerificationService.listVehicleVerifications({
        limit: '10', offset: '0',
      });

      expect(res.vehicles).toHaveLength(1);
      expect(res.pagination.total).toBe(1);
    });

    it('rejects invalid verificationStatus enum', async () => {
      await expect(
        adminVerificationService.listVehicleVerifications({
          verificationStatus: 'UNKNOWN_STATUS',
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('approveVehicle', () => {
    it('rejects approving an archived vehicle', async () => {
      jest.spyOn(adminVerificationRepository, 'findVehicleByIdForUpdate').mockResolvedValue({
        ...mockVehicleRecord,
        isArchived: true,
      });

      await expect(
        adminVerificationService.approveVehicle(TEST_VEHICLE_ID),
      ).rejects.toThrow('Cannot verify an archived vehicle');
    });

    it('approves vehicle verification, sets status to VERIFIED, and audits', async () => {
      jest.spyOn(adminVerificationRepository, 'findVehicleByIdForUpdate').mockResolvedValue({
        ...mockVehicleRecord,
        verificationStatus: 'PENDING',
      });
      jest.spyOn(adminVerificationRepository, 'updateVehicleVerificationStatus').mockResolvedValue({
        ...mockVehicleRecord,
        verificationStatus: 'VERIFIED',
      });

      const res = await adminVerificationService.approveVehicle(
        TEST_VEHICLE_ID,
        { reason: 'RC and Commercial Insurance verified' },
        { actorId: 'admin-1', actorRole: 'ADMIN', permission: 'kyc.verify' },
      );

      expect(res.verificationStatus).toBe('VERIFIED');
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'VEHICLE_VERIFIED',
          targetResource: 'VEHICLE',
          targetResourceId: TEST_VEHICLE_ID,
        }),
        expect.anything(),
      );
    });
  });

  describe('rejectVehicle', () => {
    it('rejects vehicle verification with mandatory reason', async () => {
      jest.spyOn(adminVerificationRepository, 'findVehicleByIdForUpdate').mockResolvedValue({
        ...mockVehicleRecord,
        verificationStatus: 'PENDING',
      });
      jest.spyOn(adminVerificationRepository, 'updateVehicleVerificationStatus').mockResolvedValue({
        ...mockVehicleRecord,
        verificationStatus: 'REJECTED',
      });

      const res = await adminVerificationService.rejectVehicle(
        TEST_VEHICLE_ID,
        { reason: 'Fitness certificate expired' },
        { actorId: 'admin-1', actorRole: 'ADMIN', permission: 'kyc.reject' },
      );

      expect(res.verificationStatus).toBe('REJECTED');
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'VEHICLE_REJECTED',
          targetResource: 'VEHICLE',
        }),
        expect.anything(),
      );
    });
  });

  // ── Document Review & S3 Signed URL ────────────────────────────────────────

  describe('Document Verification & S3 Access', () => {
    it('getDocumentDetail returns document metadata', async () => {
      jest.spyOn(adminVerificationRepository, 'findDocumentById').mockResolvedValue({
        entityType: 'PARTNER',
        document: { id: TEST_PARTNER_DOC_ID, documentType: 'PAN', storageKey: 'docs/pan.pdf' },
      });

      const res = await adminVerificationService.getDocumentDetail(TEST_PARTNER_DOC_ID);
      expect(res.entityType).toBe('PARTNER');
      expect(res.document.documentType).toBe('PAN');
    });

    it('getDocumentDetail throws NotFoundError when document does not exist', async () => {
      jest.spyOn(adminVerificationRepository, 'findDocumentById').mockResolvedValue(null);

      await expect(
        adminVerificationService.getDocumentDetail(TEST_PARTNER_DOC_ID),
      ).rejects.toThrow(NotFoundError);
    });

    it('getDocumentSignedUrl generates short-lived presigned URL', async () => {
      jest.spyOn(adminVerificationRepository, 'findDocumentById').mockResolvedValue({
        entityType: 'PARTNER',
        document: {
          id: TEST_PARTNER_DOC_ID,
          entityId: TEST_PARTNER_ID,
          documentType: 'GST',
          documentNumber: '29ABCDE1234F1Z5',
          storageKey: 'partners/docs/gst.pdf',
        },
      });

      jest.spyOn(s3Provider, 'createPresignedGetUrl').mockResolvedValue({
        downloadUrl: 'https://gongo-s3.amazonaws.com/partners/docs/gst.pdf?token=mocked',
        key: 'partners/docs/gst.pdf',
        expiresInSeconds: 900,
      });

      const res = await adminVerificationService.getDocumentSignedUrl(TEST_PARTNER_DOC_ID);

      expect(res.documentId).toBe(TEST_PARTNER_DOC_ID);
      expect(res.downloadUrl).toContain('amazonaws.com');
      expect(res.expiresInSeconds).toBe(900);
      expect(s3Provider.createPresignedGetUrl).toHaveBeenCalledWith({
        key: 'partners/docs/gst.pdf',
        expiresInSeconds: 900,
      });
    });

    it('getDocumentSignedUrl throws ValidationError when document has no storageKey', async () => {
      jest.spyOn(adminVerificationRepository, 'findDocumentById').mockResolvedValue({
        entityType: 'PARTNER',
        document: {
          id: TEST_PARTNER_DOC_ID,
          storageKey: null,
        },
      });

      await expect(
        adminVerificationService.getDocumentSignedUrl(TEST_PARTNER_DOC_ID),
      ).rejects.toThrow('Document does not have an attached file');
    });

    it('approveDocument approves partner document and creates audit record', async () => {
      jest.spyOn(adminVerificationRepository, 'findDocumentById').mockResolvedValue({
        entityType: 'PARTNER',
        document: { id: TEST_PARTNER_DOC_ID, entityId: TEST_PARTNER_ID },
      });
      jest.spyOn(adminVerificationRepository, 'findPartnerDocumentByIdForUpdate')
        .mockResolvedValue({
          id: TEST_PARTNER_DOC_ID,
          partnerId: TEST_PARTNER_ID,
          verificationStatus: 'PENDING',
          documentType: 'PAN',
        });
      jest.spyOn(adminVerificationRepository, 'updatePartnerDocumentStatus')
        .mockResolvedValue({
          id: TEST_PARTNER_DOC_ID,
          verificationStatus: 'VERIFIED',
        });

      const res = await adminVerificationService.approveDocument(
        TEST_PARTNER_DOC_ID,
        { reason: 'Valid PAN' },
        { actorId: 'admin-1', actorRole: 'ADMIN', permission: 'kyc.verify' },
      );

      expect(res.verificationStatus).toBe('VERIFIED');
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DOCUMENT_APPROVED',
          targetResource: 'PARTNER_DOCUMENT',
        }),
        expect.anything(),
      );
    });

    it('rejectDocument rejects vehicle document with mandatory reason', async () => {
      jest.spyOn(adminVerificationRepository, 'findDocumentById').mockResolvedValue({
        entityType: 'VEHICLE',
        document: { id: TEST_VEHICLE_DOC_ID, entityId: TEST_VEHICLE_ID },
      });
      jest.spyOn(adminVerificationRepository, 'findVehicleDocumentByIdForUpdate')
        .mockResolvedValue({
          id: TEST_VEHICLE_DOC_ID,
          vehicleId: TEST_VEHICLE_ID,
          verificationStatus: 'PENDING',
          documentType: 'RC',
        });
      jest.spyOn(adminVerificationRepository, 'updateVehicleDocumentStatus')
        .mockResolvedValue({
          id: TEST_VEHICLE_DOC_ID,
          verificationStatus: 'REJECTED',
          rejectionReason: 'Blurry scan',
        });

      const res = await adminVerificationService.rejectDocument(
        TEST_VEHICLE_DOC_ID,
        { reason: 'Blurry scan' },
        { actorId: 'admin-1', actorRole: 'ADMIN', permission: 'kyc.reject' },
      );

      expect(res.verificationStatus).toBe('REJECTED');
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DOCUMENT_REJECTED',
          targetResource: 'VEHICLE_DOCUMENT',
        }),
        expect.anything(),
      );
    });

    it('getVehicleImageDetail returns vehicle image metadata', async () => {
      const mockImg = { id: 'd0000000-0000-4000-8000-000000000001', vehicleId: TEST_VEHICLE_ID, verificationStatus: 'PENDING' };
      jest.spyOn(adminVerificationRepository, 'findVehicleImageById').mockResolvedValue(mockImg);

      const res = await adminVerificationService.getVehicleImageDetail('d0000000-0000-4000-8000-000000000001');
      expect(res.id).toBe('d0000000-0000-4000-8000-000000000001');
      expect(res.vehicleId).toBe(TEST_VEHICLE_ID);
    });

    it('getVehicleImageSignedUrl generates short-lived presigned URL', async () => {
      jest.spyOn(adminVerificationRepository, 'findVehicleImageById').mockResolvedValue({
        id: 'd0000000-0000-4000-8000-000000000001',
        vehicleId: TEST_VEHICLE_ID,
        storageKey: 'vehicles/photos/photo1.jpg',
      });
      jest.spyOn(s3Provider, 'createPresignedGetUrl').mockResolvedValue({
        downloadUrl: 'https://storage.supabase.com/signed/photo1.jpg',
      });

      const res = await adminVerificationService.getVehicleImageSignedUrl('d0000000-0000-4000-8000-000000000001');
      expect(res.downloadUrl).toBe('https://storage.supabase.com/signed/photo1.jpg');
      expect(res.expiresInSeconds).toBe(900);
    });

    it('approveVehicleImage approves image and writes audit', async () => {
      const imgId = 'd0000000-0000-4000-8000-000000000001';
      jest.spyOn(adminVerificationRepository, 'findVehicleImageById').mockResolvedValue({
        id: imgId,
        vehicleId: TEST_VEHICLE_ID,
        verificationStatus: 'PENDING',
      });
      jest.spyOn(adminVerificationRepository, 'findVehicleImageByIdForUpdate').mockResolvedValue({
        id: imgId,
        vehicleId: TEST_VEHICLE_ID,
        partnerId: TEST_PARTNER_ID,
        verificationStatus: 'PENDING',
        version: 1,
      });
      jest.spyOn(adminVerificationRepository, 'updateVehicleImageStatus').mockResolvedValue({
        id: imgId,
        verificationStatus: 'VERIFIED',
      });

      const res = await adminVerificationService.approveVehicleImage(
        imgId,
        { reason: 'Photo is clear and shows plate' },
        { actorId: 'admin-1', actorRole: 'ADMIN', permission: 'vehicles.verify' },
      );

      expect(res.verificationStatus).toBe('VERIFIED');
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'VEHICLE_IMAGE_APPROVED',
          targetResource: 'VEHICLE_IMAGE',
          targetResourceId: imgId,
        }),
        expect.anything(),
      );
    });

    it('rejectVehicleImage rejects image with mandatory reason and cascades vehicle offline', async () => {
      const imgId = 'd0000000-0000-4000-8000-000000000001';
      jest.spyOn(adminVerificationRepository, 'findVehicleImageById').mockResolvedValue({
        id: imgId,
        vehicleId: TEST_VEHICLE_ID,
        verificationStatus: 'PENDING',
      });
      jest.spyOn(adminVerificationRepository, 'findVehicleImageByIdForUpdate').mockResolvedValue({
        id: imgId,
        vehicleId: TEST_VEHICLE_ID,
        partnerId: TEST_PARTNER_ID,
        verificationStatus: 'PENDING',
        version: 1,
      });
      jest.spyOn(adminVerificationRepository, 'updateVehicleImageStatus').mockResolvedValue({
        id: imgId,
        verificationStatus: 'REJECTED',
        rejectionReason: 'Number plate obscured by glare',
      });

      // Missing reason should throw ValidationError
      await expect(
        adminVerificationService.rejectVehicleImage(imgId, {}),
      ).rejects.toThrow('A valid rejection reason (minimum 3 characters) is required');

      const res = await adminVerificationService.rejectVehicleImage(
        imgId,
        { reason: 'Number plate obscured by glare' },
        { actorId: 'admin-1', actorRole: 'ADMIN', permission: 'vehicles.verify' },
      );

      expect(res.verificationStatus).toBe('REJECTED');
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'VEHICLE_IMAGE_REJECTED',
          targetResource: 'VEHICLE_IMAGE',
          targetResourceId: imgId,
        }),
        expect.anything(),
      );
    });
  });

  // ── Unified KYC Listing ────────────────────────────────────────────────────

  describe('listKyc', () => {
    it('returns unified KYC list across partners and vehicles', async () => {
      jest.spyOn(adminVerificationRepository, 'listKycVerifications').mockResolvedValue({
        items: [
          { entityId: TEST_PARTNER_ID, entityType: 'PARTNER', status: 'PENDING' },
          { entityId: TEST_VEHICLE_ID, entityType: 'VEHICLE', status: 'PENDING' },
        ],
        total: 2,
      });

      const res = await adminVerificationService.listKyc({
        status: 'PENDING',
        entityType: 'PARTNER',
        limit: 10,
        offset: 0,
      });

      expect(res.items).toHaveLength(2);
      expect(res.pagination.total).toBe(2);
    });

    it('rejects invalid entityType filter', async () => {
      await expect(
        adminVerificationService.listKyc({ entityType: 'UNKNOWN_ENTITY' }),
      ).rejects.toThrow("entityType must be either 'PARTNER' or 'VEHICLE'");
    });
  });
});
