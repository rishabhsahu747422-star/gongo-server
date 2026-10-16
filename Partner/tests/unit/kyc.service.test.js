'use strict';

const kycService = require('../../src/services/kyc.service');
const auditService = require('../../src/services/audit.service');
const { NotFoundError } = require('../../src/errors');

describe('Unit: KycService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getKycOverview', () => {
    it('returns kyc overview with masked document numbers', async () => {
      jest.spyOn(kycService.partnerRepository, 'findById').mockResolvedValue({
        id: 'partner-123',
        is_active: true,
        kyc_status: 'PENDING',
      });

      jest.spyOn(kycService.documentRepository, 'findLatestByPartnerId').mockResolvedValue([
        {
          id: 'doc-1',
          document_type: 'AADHAAR',
          document_number: '123456788910',
          verification_status: 'VERIFIED',
          version: 1,
          rejection_reason: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          id: 'doc-2',
          document_type: 'PAN',
          document_number: 'ABCDE1234F',
          verification_status: 'PENDING',
          version: 1,
          rejection_reason: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]);

      const overview = await kycService.getKycOverview('partner-123');

      expect(overview.kycStatus).toBe('PENDING');
      expect(overview.documents).toHaveLength(2);
      expect(overview.documents[0].documentNumberMasked).toBe('•••• •••• 8910');
      expect(overview.documents[1].documentNumberMasked).toBe('AB••••••4F');
      expect(overview.requiredDocumentTypes).toContain('AADHAAR');
    });

    it('throws NotFoundError when partner not found', async () => {
      jest.spyOn(kycService.partnerRepository, 'findById').mockResolvedValue(null);

      await expect(kycService.getKycOverview('unknown')).rejects.toThrow(NotFoundError);
    });
  });

  describe('submitDocument', () => {
    it('increments version and enforces PENDING status and server storageKey', async () => {
      jest.spyOn(kycService.partnerRepository, 'findById').mockResolvedValue({
        id: 'partner-123',
        is_active: true,
        kyc_status: 'PENDING',
      });

      jest.spyOn(kycService.partnerRepository, 'lockForUpdate').mockResolvedValue({
        id: 'partner-123',
        is_active: true,
        kyc_status: 'PENDING',
      });

      jest.spyOn(kycService.documentRepository, 'findMaxVersion').mockResolvedValue(1);

      const auditSpy = jest.spyOn(auditService, 'logEvent').mockImplementation(() => {});

      const createdRow = {
        id: 'doc-new-v2',
        partner_id: 'partner-123',
        document_type: 'AADHAAR',
        document_number: '123456788910',
        storage_key: 'kyc-documents/partner-123/aadhaar_v2',
        verification_status: 'PENDING',
        version: 2,
        rejection_reason: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      jest.spyOn(kycService.documentRepository, 'createDocument').mockResolvedValue(createdRow);

      const result = await kycService.submitDocument('partner-123', {
        documentType: 'AADHAAR',
        documentNumber: '123456788910',
      });

      expect(result.id).toBe('doc-new-v2');
      expect(result.version).toBe(2);
      expect(result.verificationStatus).toBe('PENDING');
      expect(result.documentNumberMasked).toBe('•••• •••• 8910');

      // Verify audit log DOES NOT contain raw Aadhaar document number
      expect(auditSpy).toHaveBeenCalledTimes(1);
      const auditPayload = auditSpy.mock.calls[0][0];
      expect(auditPayload.metadata.documentType).toBe('AADHAAR');
      expect(auditPayload.metadata.version).toBe(2);
      expect(JSON.stringify(auditPayload)).not.toContain('123456788910');
    });
  });

  describe('getDocumentById', () => {
    it('returns masked document when found for partner', async () => {
      jest.spyOn(kycService.documentRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: 'doc-1',
        partner_id: 'partner-123',
        document_type: 'AADHAAR',
        document_number: '123456788910',
        verification_status: 'PENDING',
        version: 1,
      });

      const doc = await kycService.getDocumentById('doc-1', 'partner-123');
      expect(doc.id).toBe('doc-1');
      expect(doc.documentNumberMasked).toBe('•••• •••• 8910');
    });

    it('throws NotFoundError when document does not belong to partner (IDOR protection)', async () => {
      jest.spyOn(kycService.documentRepository, 'findByIdAndPartnerId').mockResolvedValue(null);

      await expect(kycService.getDocumentById('doc-other', 'partner-123')).rejects.toThrow(NotFoundError);
    });
  });
});
