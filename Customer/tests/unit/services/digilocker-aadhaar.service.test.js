'use strict';

const AadhaarVerificationService = require('../../../src/services/aadhaar-verification.service');
const DigiLockerProvider = require('../../../src/providers/digilocker.provider');
const {
  AADHAAR_VERIFICATION_STATUS,
  AADHAAR_DOCUMENT_TYPE,
  AADHAAR_PROVIDERS,
  AUDIT_EVENT_TYPES,
} = require('../../../src/constants/aadhaar');
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
  ServiceUnavailableError,
} = require('../../../src/errors');

describe('DigiLocker Aadhaar XML Verification Service Unit Tests', () => {
  let service;
  let mockCustomerRepo;
  let mockDocumentRepo;
  let mockVerificationRepo;
  let mockDigiLocker;
  let mockRedis;
  let mockSupabase;
  let mockStorageBucket;

  const customerId = '00000000-0000-4000-8000-000000000001';
  const otherCustomerId = '00000000-0000-4000-8000-000000000002';
  const verificationId = '11111111-1111-4111-8111-111111111111';
  const sampleState = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

  const validAadhaarXml = `<?xml version="1.0" encoding="UTF-8"?>
<UidData uid="XXXXXXXX1234">
  <Poi dob="01-01-1990" gender="M" name="Test User"/>
  <Poa city="Bhopal" dist="Bhopal" state="Madhya Pradesh" pc="462001"/>
</UidData>`;

  const mockActiveUser = {
    id: customerId,
    name: 'Test Customer',
    phone: '9876543210',
    isActive: true,
  };

  beforeEach(() => {
    mockCustomerRepo = {
      findById: jest.fn().mockResolvedValue(mockActiveUser),
    };

    mockDocumentRepo = {
      create: jest.fn().mockResolvedValue({ id: 'doc-uuid-1', status: 'VERIFIED' }),
      findLatestByUserAndType: jest.fn().mockResolvedValue(null),
    };

    mockVerificationRepo = {
      createVerification: jest.fn().mockImplementation((data) => Promise.resolve({ ...data, createdAt: new Date() })),
      findById: jest.fn(),
      findLatestByCustomerId: jest.fn(),
      updateVerification: jest.fn().mockImplementation((id, data) => Promise.resolve({ id, customerId, ...data })),
      findByProviderReferenceId: jest.fn().mockResolvedValue(null),
      query: jest.fn().mockResolvedValue({ rows: [] }),
      createAuditEvent: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      findAuditsByVerificationId: jest.fn().mockResolvedValue([]),
    };

    mockDigiLocker = {
      generateState: jest.fn().mockReturnValue(sampleState),
      resolveRedirectUri: jest.fn().mockReturnValue('https://api.gongo.in/api/v1/customers/aadhaar/callback'),
      initiateSession: jest.fn().mockResolvedValue({
        authorizationUrl: 'https://api.digitallocker.gov.in/public/oauth2/1/authorize?client_id=test&state=' + sampleState,
        provider: AADHAAR_PROVIDERS.DIGILOCKER_SANDBOX,
        providerReferenceId: 'digilocker_ref_123',
      }),
      exchangeCodeForToken: jest.fn().mockResolvedValue({
        accessToken: 'mock_access_token_xyz',
        tokenType: 'Bearer',
        expiresIn: 3600,
        digilockerId: 'dl_user_999',
      }),
      fetchAadhaarXml: jest.fn().mockResolvedValue({
        xmlContent: validAadhaarXml,
        documentType: 'AADHAAR',
        maskedAadhaar: 'XXXX-XXXX-1234',
        isAuthorized: true,
      }),
      validateXmlStructure: new DigiLockerProvider().validateXmlStructure,
      extractMaskedAadhaar: new DigiLockerProvider().extractMaskedAadhaar,
      isSandboxCoInMode: jest.fn().mockReturnValue(false),
      getSessionStatus: jest.fn().mockResolvedValue({ status: 'completed', isCompleted: true }),
    };

    mockRedis = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(1),
    };

    mockStorageBucket = {
      upload: jest.fn().mockResolvedValue({ data: { path: `${customerId}/aadhaar/${verificationId}.xml` }, error: null }),
      createSignedUrl: jest.fn().mockResolvedValue({ data: { signedUrl: 'https://storage.supabase.local/signed-url' }, error: null }),
    };

    mockSupabase = {
      storage: {
        from: jest.fn().mockReturnValue(mockStorageBucket),
      },
    };

    service = new AadhaarVerificationService({
      customerRepo: mockCustomerRepo,
      documentRepo: mockDocumentRepo,
      verificationRepo: mockVerificationRepo,
      digilocker: mockDigiLocker,
      redis: mockRedis,
      supabase: () => mockSupabase,
    });
  });

  describe('1. Session Initiation', () => {
    it('successfully initiates a DigiLocker session with unpredictable state', async () => {
      const result = await service.initiateVerification(customerId, {
        ipAddress: '127.0.0.1',
        userAgent: 'GONGO-Mobile/1.0',
      });

      expect(result).toHaveProperty('verificationId');
      expect(result).toHaveProperty('authorizationUrl');
      expect(result.state).toBe(sampleState);
      expect(result.provider).toBe(AADHAAR_PROVIDERS.DIGILOCKER_SANDBOX);

      // Verifies DB record was created with IN_PROGRESS status
      expect(mockVerificationRepo.createVerification).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId,
          documentType: AADHAAR_DOCUMENT_TYPE,
          verificationStatus: AADHAAR_VERIFICATION_STATUS.IN_PROGRESS,
          provider: AADHAAR_PROVIDERS.DIGILOCKER_SANDBOX,
        })
      );

      // Verifies session cached in Redis with TTL
      expect(mockRedis.set).toHaveBeenCalledWith(
        `aadhaar:session:${sampleState}`,
        expect.any(String),
        'EX',
        900
      );

      // Verifies non-sensitive audit event logged
      expect(mockVerificationRepo.createAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId,
          eventType: AUDIT_EVENT_TYPES.SESSION_INITIATED,
        })
      );
    });

    it('rejects initiation for non-existent customer', async () => {
      mockCustomerRepo.findById.mockResolvedValue(null);

      await expect(service.initiateVerification(customerId)).rejects.toThrow(NotFoundError);
    });

    it('rejects initiation for deactivated customer', async () => {
      mockCustomerRepo.findById.mockResolvedValue({ ...mockActiveUser, isActive: false });

      await expect(service.initiateVerification(customerId)).rejects.toThrow(ForbiddenError);
    });
  });

  describe('2. Callback Handling & XML Storage', () => {
    beforeEach(() => {
      // Mock Redis state lookup hit for valid sampleState
      mockRedis.get.mockImplementation((key) => {
        if (key && key.includes(sampleState)) {
          return Promise.resolve(JSON.stringify({
            verificationId,
            customerId,
            state: sampleState,
            redirectUri: 'https://api.gongo.in/api/v1/customers/aadhaar/callback',
          }));
        }
        return Promise.resolve(null);
      });

      // Mock DB verification record
      mockVerificationRepo.findById.mockResolvedValue({
        id: verificationId,
        customerId,
        documentType: 'AADHAAR',
        verificationStatus: AADHAAR_VERIFICATION_STATUS.IN_PROGRESS,
        provider: AADHAAR_PROVIDERS.DIGILOCKER_SANDBOX,
        providerReferenceId: 'digilocker_ref_123',
        consentRecord: { consentGiven: true },
      });
    });

    it('successfully validates code, fetches XML, uploads to Supabase Storage, and updates DB', async () => {
      const result = await service.handleCallback({
        state: sampleState,
        code: 'valid_auth_code_123',
        ipAddress: '127.0.0.1',
      });

      expect(result.status).toBe(AADHAAR_VERIFICATION_STATUS.VERIFIED);
      expect(result.verificationId).toBe(verificationId);
      expect(result.maskedAadhaar).toBe('XXXX-XXXX-1234');

      // Token exchange executed
      expect(mockDigiLocker.exchangeCodeForToken).toHaveBeenCalledWith({
        code: 'valid_auth_code_123',
        redirectUri: 'https://api.gongo.in/api/v1/customers/aadhaar/callback',
      });

      // Document fetch executed
      expect(mockDigiLocker.fetchAadhaarXml).toHaveBeenCalledWith({
        accessToken: 'mock_access_token_xyz',
      });

      // Supabase Storage upload called with private bucket and server-generated path
      expect(mockSupabase.storage.from).toHaveBeenCalledWith('customer-identity-documents');
      expect(mockStorageBucket.upload).toHaveBeenCalledWith(
        `${customerId}/aadhaar/${verificationId}.xml`,
        expect.any(Buffer),
        expect.objectContaining({ contentType: 'application/xml', upsert: true })
      );

      // Database verification updated to VERIFIED
      expect(mockVerificationRepo.updateVerification).toHaveBeenCalledWith(
        verificationId,
        expect.objectContaining({
          verificationStatus: AADHAAR_VERIFICATION_STATUS.VERIFIED,
          storageBucket: 'customer-identity-documents',
          storagePath: `${customerId}/aadhaar/${verificationId}.xml`,
        })
      );

      // Customer documents table updated for general KYC verification
      expect(mockDocumentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: customerId,
          documentType: 'AADHAAR',
          status: 'VERIFIED',
        })
      );

      // Audit event logged
      expect(mockVerificationRepo.createAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          verificationId,
          customerId,
          eventType: AUDIT_EVENT_TYPES.VERIFICATION_COMPLETED,
        })
      );
    });

    it('is idempotent on duplicate callback retries for already verified record', async () => {
      mockVerificationRepo.findById.mockResolvedValue({
        id: verificationId,
        customerId,
        verificationStatus: AADHAAR_VERIFICATION_STATUS.VERIFIED,
        consentRecord: { maskedAadhaar: 'XXXX-XXXX-1234' },
      });

      const result = await service.handleCallback({
        state: sampleState,
        code: 'valid_auth_code_123',
      });

      expect(result.status).toBe(AADHAAR_VERIFICATION_STATUS.VERIFIED);
      // Does not re-upload to storage or re-exchange token
      expect(mockDigiLocker.exchangeCodeForToken).not.toHaveBeenCalled();
      expect(mockStorageBucket.upload).not.toHaveBeenCalled();
    });

    it('handles user cancellation gracefully', async () => {
      const result = await service.handleCallback({
        state: sampleState,
        error: 'access_denied',
        errorDescription: 'User cancelled DigiLocker authorization',
      });

      expect(result.status).toBe(AADHAAR_VERIFICATION_STATUS.CANCELLED);
      expect(mockVerificationRepo.updateVerification).toHaveBeenCalledWith(
        verificationId,
        expect.objectContaining({
          verificationStatus: AADHAAR_VERIFICATION_STATUS.CANCELLED,
        })
      );
      expect(mockVerificationRepo.createAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: AUDIT_EVENT_TYPES.VERIFICATION_CANCELLED,
        })
      );
    });

    it('rejects invalid or missing OAuth state', async () => {
      await expect(service.handleCallback({ state: '' })).rejects.toThrow(BadRequestError);
      await expect(service.handleCallback({ state: 'unknown_nonexistent_state' })).rejects.toThrow(BadRequestError);
    });

    it('handles document fetch failure and marks record as FAILED', async () => {
      mockDigiLocker.fetchAadhaarXml.mockRejectedValue(new BadRequestError('Document not found', 'DOC_NOT_FOUND'));

      await expect(
        service.handleCallback({
          state: sampleState,
          code: 'valid_auth_code_123',
        })
      ).rejects.toThrow(BadRequestError);

      expect(mockVerificationRepo.updateVerification).toHaveBeenCalledWith(
        verificationId,
        expect.objectContaining({
          verificationStatus: AADHAAR_VERIFICATION_STATUS.FAILED,
        })
      );
    });

    it('rejects callback with unknown sessionId alone', async () => {
      mockVerificationRepo.findByProviderReferenceId.mockResolvedValue(null);
      await expect(
        service.handleCallback({ sessionId: 'unknown_ref_123' })
      ).rejects.toThrow(BadRequestError);
    });

    it('successfully processes callback with sessionId alone without state (Sandbox redirect)', async () => {
      mockVerificationRepo.findByProviderReferenceId.mockResolvedValue({
        id: verificationId,
        customerId,
        documentType: 'AADHAAR',
        verificationStatus: AADHAAR_VERIFICATION_STATUS.IN_PROGRESS,
        provider: AADHAAR_PROVIDERS.DIGILOCKER_SANDBOX,
        providerReferenceId: 'digilocker_ref_123',
        consentRecord: { consentGiven: true },
        createdAt: new Date(),
      });

      const result = await service.handleCallback({
        sessionId: 'digilocker_ref_123',
      });

      expect(result.status).toBe(AADHAAR_VERIFICATION_STATUS.VERIFIED);
      expect(result.verificationId).toBe(verificationId);
    });

    it('rejects callback when sessionId mismatches the stored verification record', async () => {
      await expect(
        service.handleCallback({
          state: sampleState,
          sessionId: 'mismatched_session_id',
        })
      ).rejects.toThrow(BadRequestError);
    });

    it('rejects callback when Sandbox provider reports status is incomplete', async () => {
      mockDigiLocker.isSandboxCoInMode.mockReturnValue(true);
      mockDigiLocker.getSessionStatus = jest.fn().mockResolvedValue({
        status: 'created',
        isCompleted: false,
      });

      await expect(
        service.handleCallback({
          state: sampleState,
          sessionId: 'digilocker_ref_123',
        })
      ).rejects.toThrow(BadRequestError);
    });

    it('completes Sandbox verification without OAuth code when status is completed and state matches', async () => {
      mockDigiLocker.isSandboxCoInMode.mockReturnValue(true);
      mockDigiLocker.getSessionStatus = jest.fn().mockResolvedValue({
        status: 'completed',
        isCompleted: true,
      });

      const result = await service.handleCallback({
        state: sampleState,
        sessionId: 'digilocker_ref_123',
      });

      expect(result.status).toBe(AADHAAR_VERIFICATION_STATUS.VERIFIED);
      expect(mockDigiLocker.fetchAadhaarXml).toHaveBeenCalledWith({
        sessionId: 'digilocker_ref_123',
      });
      expect(mockVerificationRepo.updateVerification).toHaveBeenCalledWith(
        verificationId,
        expect.objectContaining({
          verificationStatus: AADHAAR_VERIFICATION_STATUS.VERIFIED,
          providerReferenceId: 'digilocker_ref_123',
        })
      );
    });

    it('handles Supabase Storage upload failure without falsely marking as VERIFIED', async () => {
      mockStorageBucket.upload.mockResolvedValue({ data: null, error: { message: 'Storage bucket unavailable' } });

      await expect(
        service.handleCallback({
          state: sampleState,
          code: 'valid_auth_code_123',
        })
      ).rejects.toThrow(ServiceUnavailableError);

      expect(mockVerificationRepo.updateVerification).toHaveBeenCalledWith(
        verificationId,
        expect.objectContaining({
          verificationStatus: AADHAAR_VERIFICATION_STATUS.FAILED,
        })
      );
    });
  });

  describe('3. XML Structure Validation & Data Sanitization', () => {
    it('validates authentic Aadhaar XML correctly', () => {
      const provider = new DigiLockerProvider();
      const res = provider.validateXmlStructure(validAadhaarXml);
      expect(res.isValid).toBe(true);
    });

    it('rejects JSON error responses masquerading as XML', () => {
      const provider = new DigiLockerProvider();
      const res = provider.validateXmlStructure('{"error": "invalid_grant"}');
      expect(res.isValid).toBe(false);
      expect(res.reason).toContain('HTML/JSON');
    });

    it('rejects HTML error pages', () => {
      const provider = new DigiLockerProvider();
      const res = provider.validateXmlStructure('<!DOCTYPE html><html><body>Error 500</body></html>');
      expect(res.isValid).toBe(false);
    });

    it('rejects payloads smaller than minimum size limit', () => {
      const provider = new DigiLockerProvider();
      const res = provider.validateXmlStructure('<xml></xml>');
      expect(res.isValid).toBe(false);
    });

    it('extracts only masked Aadhaar (last 4 digits) and never returns plaintext 12 digits', () => {
      const provider = new DigiLockerProvider();
      const masked = provider.extractMaskedAadhaar(validAadhaarXml);
      expect(masked).toBe('XXXX-XXXX-1234');
      expect(masked).not.toMatch(/^\d{12}$/);
    });
  });

  describe('4. Status Retrieval & Signed URL Security', () => {
    it('returns NOT_VERIFIED when no verification records exist', async () => {
      mockVerificationRepo.findLatestByCustomerId.mockResolvedValue(null);

      const status = await service.getStatus(customerId);
      expect(status.verificationStatus).toBe(AADHAAR_VERIFICATION_STATUS.NOT_VERIFIED);
      expect(status.isVerified).toBe(false);
    });

    it('returns VERIFIED with safe metadata when verified', async () => {
      mockVerificationRepo.findLatestByCustomerId.mockResolvedValue({
        verificationStatus: AADHAAR_VERIFICATION_STATUS.VERIFIED,
        verifiedAt: new Date('2026-03-01T12:00:00Z'),
        consentRecord: { maskedAadhaar: 'XXXX-XXXX-1234' },
        createdAt: new Date('2026-03-01T11:55:00Z'),
        provider: AADHAAR_PROVIDERS.DIGILOCKER_SANDBOX,
      });

      const status = await service.getStatus(customerId);
      expect(status.verificationStatus).toBe(AADHAAR_VERIFICATION_STATUS.VERIFIED);
      expect(status.isVerified).toBe(true);
      expect(status.maskedAadhaar).toBe('XXXX-XXXX-1234');
      // Full raw path or XML content is not returned in safe status DTO
      expect(status).not.toHaveProperty('storagePath');
      expect(status).not.toHaveProperty('xmlContent');
    });

    it('generates short-lived signed URL for authorized owner', async () => {
      mockVerificationRepo.findById.mockResolvedValue({
        id: verificationId,
        customerId,
        verificationStatus: AADHAAR_VERIFICATION_STATUS.VERIFIED,
        storageBucket: 'customer-identity-documents',
        storagePath: `${customerId}/aadhaar/${verificationId}.xml`,
      });

      const res = await service.getSignedDocumentUrl(customerId, verificationId);
      expect(res.downloadUrl).toBe('https://storage.supabase.local/signed-url');
      expect(res.expiresInSeconds).toBe(60);
    });

    it('blocks unauthorized access to another customer document', async () => {
      mockVerificationRepo.findById.mockResolvedValue({
        id: verificationId,
        customerId: otherCustomerId, // Owned by another customer!
        verificationStatus: AADHAAR_VERIFICATION_STATUS.VERIFIED,
        storagePath: `${otherCustomerId}/aadhaar/${verificationId}.xml`,
      });

      await expect(service.getSignedDocumentUrl(customerId, verificationId)).rejects.toThrow(ForbiddenError);
    });
  });
});
