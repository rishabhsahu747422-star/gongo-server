'use strict';

const { AdminStorageService } = require('../../src/services/admin-storage.service');
const { BadRequestError, NotFoundError } = require('../../src/errors');

const TEST_DOC_ID = 'da000001-0000-4000-a000-000000000001';
const TEST_PARTNER_ID = 'ba000001-0000-4000-a000-000000000001';
const TEST_VEHICLE_ID = 'ea000001-0000-4000-a000-000000000001';
const TEST_CUSTOMER_ID = 'ca000001-0000-4000-a000-000000000001';

describe('Unit: AdminStorageService', () => {
  let service;
  let mockStorageRepo;
  let mockS3;
  let mockAudit;

  beforeEach(() => {
    mockStorageRepo = {
      listDocuments: jest.fn(),
      findDocumentById: jest.fn(),
      findDocumentsByPartner: jest.fn(),
      findDocumentsByVehicle: jest.fn(),
      findDocumentsByCustomer: jest.fn(),
      findDocumentHistory: jest.fn(),
    };

    mockS3 = {
      createPresignedGetUrl: jest.fn(),
      headObject: jest.fn(),
    };

    mockAudit = {
      logAdminAction: jest.fn(),
    };

    service = new AdminStorageService(mockStorageRepo, mockS3, mockAudit);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('1. listDocuments', () => {
    it('successfully lists documents with valid parameters', async () => {
      mockStorageRepo.listDocuments.mockResolvedValueOnce({
        items: [{ id: TEST_DOC_ID }],
        pagination: { total: 1, page: 1, limit: 20, totalPages: 1 },
      });

      const result = await service.listDocuments({
        page: 1,
        limit: 20,
        partnerId: TEST_PARTNER_ID,
        startDate: '2026-09-01T00:00:00.000Z',
        endDate: '2026-09-10T23:59:59.999Z',
      });

      expect(mockStorageRepo.listDocuments).toHaveBeenCalledWith(
        expect.objectContaining({
          partnerId: TEST_PARTNER_ID,
          startDate: '2026-09-01T00:00:00.000Z',
          endDate: '2026-09-10T23:59:59.999Z',
        }),
      );
      expect(result.items).toHaveLength(1);
    });

    it('rejects malformed partnerId UUID', async () => {
      await expect(
        service.listDocuments({ partnerId: 'not-a-uuid' }),
      ).rejects.toThrow(BadRequestError);
      expect(mockStorageRepo.listDocuments).not.toHaveBeenCalled();
    });

    it('rejects malformed vehicleId UUID', async () => {
      await expect(
        service.listDocuments({ vehicleId: 'not-a-uuid' }),
      ).rejects.toThrow(BadRequestError);
    });

    it('rejects malformed customerId UUID', async () => {
      await expect(
        service.listDocuments({ customerId: 'not-a-uuid' }),
      ).rejects.toThrow(BadRequestError);
    });

    it('rejects date range where startDate is after endDate', async () => {
      await expect(
        service.listDocuments({
          startDate: '2026-09-15T00:00:00.000Z',
          endDate: '2026-09-10T00:00:00.000Z',
        }),
      ).rejects.toThrow(BadRequestError);
    });

    it('rejects date range exceeding 90 days', async () => {
      await expect(
        service.listDocuments({
          startDate: '2026-01-01T00:00:00.000Z',
          endDate: '2026-06-01T00:00:00.000Z',
        }),
      ).rejects.toThrow(BadRequestError);
    });
  });

  describe('2. getDocumentDetail', () => {
    it('returns document with fileMetadata when S3 object exists', async () => {
      mockStorageRepo.findDocumentById.mockResolvedValueOnce({
        id: TEST_DOC_ID,
        ownerType: 'PARTNER',
        ownerId: TEST_PARTNER_ID,
        documentType: 'PAN',
        storageKey: 'partners/docs/pan-1.pdf',
      });

      mockS3.headObject.mockResolvedValueOnce({
        contentLength: 2048,
        contentType: 'application/pdf',
        lastModified: new Date('2026-09-01'),
      });

      const doc = await service.getDocumentDetail(TEST_DOC_ID, { actorId: 'admin-1' });

      expect(mockStorageRepo.findDocumentById).toHaveBeenCalledWith(TEST_DOC_ID);
      expect(mockS3.headObject).toHaveBeenCalledWith({ key: 'partners/docs/pan-1.pdf' });
      expect(doc.fileMetadata).toEqual({
        contentLength: 2048,
        contentType: 'application/pdf',
        lastModified: expect.any(Date),
        exists: true,
      });
      expect(mockAudit.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DOCUMENT_VIEWED',
          targetResourceId: TEST_DOC_ID,
        }),
      );
    });

    it('handles missing S3 object gracefully without crashing', async () => {
      mockStorageRepo.findDocumentById.mockResolvedValueOnce({
        id: TEST_DOC_ID,
        ownerType: 'PARTNER',
        storageKey: 'partners/docs/missing.pdf',
      });

      mockS3.headObject.mockResolvedValueOnce(null);

      const doc = await service.getDocumentDetail(TEST_DOC_ID);
      expect(doc.fileMetadata).toEqual({ exists: false });
    });

    it('throws BadRequestError for malformed document UUID', async () => {
      await expect(service.getDocumentDetail('invalid-uuid')).rejects.toThrow(
        BadRequestError,
      );
    });

    it('throws NotFoundError when document does not exist in DB', async () => {
      mockStorageRepo.findDocumentById.mockResolvedValueOnce(null);
      await expect(service.getDocumentDetail(TEST_DOC_ID)).rejects.toThrow(NotFoundError);
    });
  });

  describe('3. getDocumentSignedUrl', () => {
    it('generates presigned download URL with 900 seconds expiry', async () => {
      mockStorageRepo.findDocumentById.mockResolvedValueOnce({
        id: TEST_DOC_ID,
        ownerType: 'PARTNER',
        ownerId: TEST_PARTNER_ID,
        documentType: 'PAN',
        storageKey: 'partners/docs/pan-1.pdf',
      });

      mockS3.headObject.mockResolvedValueOnce({
        contentLength: 4096,
        contentType: 'application/pdf',
      });

      mockS3.createPresignedGetUrl.mockResolvedValueOnce({
        downloadUrl: 'https://s3.amazonaws.com/bucket/key?signature=abc',
        expiresInSeconds: 900,
      });

      const res = await service.getDocumentSignedUrl(TEST_DOC_ID, { actorId: 'admin-1' });

      expect(mockS3.createPresignedGetUrl).toHaveBeenCalledWith({
        key: 'partners/docs/pan-1.pdf',
        expiresInSeconds: 900,
      });
      expect(res.downloadUrl).toBe('https://s3.amazonaws.com/bucket/key?signature=abc');
      expect(res.expiresInSeconds).toBe(900);
      expect(res.fileSize).toBe(4096);
      expect(res.mimeType).toBe('application/pdf');

      expect(mockAudit.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DOCUMENT_SIGNED_URL_GENERATED',
          targetResourceId: TEST_DOC_ID,
        }),
      );
      // Ensure downloadUrl is NOT leaked in audit metadata
      const auditCall = mockAudit.logAdminAction.mock.calls[0][0];
      expect(auditCall.metadata.downloadUrl).toBeUndefined();
    });

    it('throws BadRequestError when document has no storageKey', async () => {
      mockStorageRepo.findDocumentById.mockResolvedValueOnce({
        id: TEST_DOC_ID,
        ownerType: 'PARTNER',
        storageKey: null,
      });

      await expect(service.getDocumentSignedUrl(TEST_DOC_ID)).rejects.toThrow(
        BadRequestError,
      );
      expect(mockS3.createPresignedGetUrl).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when S3 object is missing in bucket', async () => {
      mockStorageRepo.findDocumentById.mockResolvedValueOnce({
        id: TEST_DOC_ID,
        ownerType: 'PARTNER',
        storageKey: 'partners/docs/nonexistent.pdf',
      });

      mockS3.headObject.mockResolvedValueOnce(null);

      await expect(service.getDocumentSignedUrl(TEST_DOC_ID)).rejects.toThrow(
        NotFoundError,
      );
      expect(mockS3.createPresignedGetUrl).not.toHaveBeenCalled();
    });
  });

  describe('4. previewDocument', () => {
    it('generates presigned URL with inline disposition', async () => {
      mockStorageRepo.findDocumentById.mockResolvedValueOnce({
        id: TEST_DOC_ID,
        ownerType: 'VEHICLE',
        ownerId: TEST_VEHICLE_ID,
        documentType: 'RC',
        storageKey: 'vehicles/docs/rc-1.pdf',
      });

      mockS3.headObject.mockResolvedValueOnce({
        contentLength: 1024,
        contentType: 'application/pdf',
      });

      mockS3.createPresignedGetUrl.mockResolvedValueOnce({
        downloadUrl: 'https://s3.amazonaws.com/bucket/preview?signature=def',
        expiresInSeconds: 900,
      });

      const res = await service.previewDocument(TEST_DOC_ID);

      expect(mockS3.createPresignedGetUrl).toHaveBeenCalledWith({
        key: 'vehicles/docs/rc-1.pdf',
        expiresInSeconds: 900,
        responseContentDisposition: 'inline',
      });
      expect(res.previewUrl).toBe('https://s3.amazonaws.com/bucket/preview?signature=def');
      expect(mockAudit.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'DOCUMENT_PREVIEWED' }),
      );
    });
  });

  describe('5. downloadDocument', () => {
    it('generates presigned URL with attachment disposition and safe filename', async () => {
      mockStorageRepo.findDocumentById.mockResolvedValueOnce({
        id: TEST_DOC_ID,
        ownerType: 'PARTNER',
        ownerId: TEST_PARTNER_ID,
        documentType: 'GST',
        storageKey: 'partners/docs/gst-cert.pdf',
      });

      mockS3.headObject.mockResolvedValueOnce({
        contentLength: 5000,
        contentType: 'application/pdf',
      });

      mockS3.createPresignedGetUrl.mockResolvedValueOnce({
        downloadUrl: 'https://s3.amazonaws.com/bucket/download?signature=ghi',
        expiresInSeconds: 900,
      });

      const res = await service.downloadDocument(TEST_DOC_ID);

      expect(mockS3.createPresignedGetUrl).toHaveBeenCalledWith({
        key: 'partners/docs/gst-cert.pdf',
        expiresInSeconds: 900,
        responseContentDisposition: expect.stringContaining('attachment; filename="gst_da000001.pdf"'),
      });
      expect(res.filename).toBe('gst_da000001.pdf');
      expect(mockAudit.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'DOCUMENT_DOWNLOADED' }),
      );
    });
  });

  describe('6. getDocumentHistory', () => {
    it('returns history list for existing document', async () => {
      mockStorageRepo.findDocumentById.mockResolvedValueOnce({ id: TEST_DOC_ID });
      mockStorageRepo.findDocumentHistory.mockResolvedValueOnce([{ id: 'hist-1' }]);

      const res = await service.getDocumentHistory(TEST_DOC_ID);

      expect(mockStorageRepo.findDocumentHistory).toHaveBeenCalledWith(TEST_DOC_ID);
      expect(res).toHaveLength(1);
    });

    it('throws NotFoundError if document does not exist', async () => {
      mockStorageRepo.findDocumentById.mockResolvedValueOnce(null);
      await expect(service.getDocumentHistory(TEST_DOC_ID)).rejects.toThrow(NotFoundError);
      expect(mockStorageRepo.findDocumentHistory).not.toHaveBeenCalled();
    });
  });

  describe('7. Entity-specific document listings', () => {
    it('getPartnerDocuments returns partner documents', async () => {
      mockStorageRepo.findDocumentsByPartner.mockResolvedValueOnce({
        partner: { id: TEST_PARTNER_ID },
        documents: [],
      });

      const res = await service.getPartnerDocuments(TEST_PARTNER_ID);
      expect(res.partner.id).toBe(TEST_PARTNER_ID);
    });

    it('getPartnerDocuments throws NotFoundError when partner not found', async () => {
      mockStorageRepo.findDocumentsByPartner.mockResolvedValueOnce(null);
      await expect(service.getPartnerDocuments(TEST_PARTNER_ID)).rejects.toThrow(
        NotFoundError,
      );
    });

    it('getVehicleDocuments returns vehicle documents', async () => {
      mockStorageRepo.findDocumentsByVehicle.mockResolvedValueOnce({
        vehicle: { id: TEST_VEHICLE_ID },
        documents: [],
      });

      const res = await service.getVehicleDocuments(TEST_VEHICLE_ID);
      expect(res.vehicle.id).toBe(TEST_VEHICLE_ID);
    });

    it('getCustomerDocuments returns customer documents', async () => {
      mockStorageRepo.findDocumentsByCustomer.mockResolvedValueOnce({
        customer: { id: TEST_CUSTOMER_ID },
        documents: [],
      });

      const res = await service.getCustomerDocuments(TEST_CUSTOMER_ID);
      expect(res.customer.id).toBe(TEST_CUSTOMER_ID);
    });
  });
});
