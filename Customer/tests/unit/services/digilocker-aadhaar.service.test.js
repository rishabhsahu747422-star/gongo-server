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
  ConflictError,
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
      updateProfile: jest.fn().mockResolvedValue({ ...mockActiveUser, name: 'Test User' }),
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
      findIdentityLinkByHash: jest.fn().mockResolvedValue(null),
      findIdentityLinkByCustomerId: jest.fn().mockResolvedValue(null),
      upsertIdentityLink: jest.fn().mockResolvedValue({ id: 'link-1' }),
      deleteIdentityLinkByVerificationId: jest.fn().mockResolvedValue(true),
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
      upload: jest.fn().mockResolvedValue({ data: { path: `customers/${customerId}/aadhaar/${verificationId}.xml` }, error: null }),
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

      // Supabase Storage upload called with configured bucket and server-generated path
      expect(mockSupabase.storage.from).toHaveBeenCalledWith('gongo-customers');
      expect(mockStorageBucket.upload).toHaveBeenCalledWith(
        `customers/${customerId}/aadhaar/${verificationId}.xml`,
        expect.any(Buffer),
        expect.objectContaining({ contentType: 'application/xml', upsert: true })
      );

      // Database verification updated to VERIFIED
      expect(mockVerificationRepo.updateVerification).toHaveBeenCalledWith(
        verificationId,
        expect.objectContaining({
          verificationStatus: AADHAAR_VERIFICATION_STATUS.VERIFIED,
          storageBucket: 'gongo-customers',
          storagePath: `customers/${customerId}/aadhaar/${verificationId}.xml`,
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

    it('respects configured storageBucket (e.g. custom-customer-bucket) and uploads to customers/<customerId>/aadhaar/<verificationId>.xml', async () => {
      const customService = new AadhaarVerificationService({
        customerRepo: mockCustomerRepo,
        documentRepo: mockDocumentRepo,
        verificationRepo: mockVerificationRepo,
        digilocker: mockDigiLocker,
        redis: mockRedis,
        supabase: () => mockSupabase,
        storageBucket: 'custom-customer-bucket',
      });

      await customService.handleCallback({
        state: sampleState,
        code: 'valid_auth_code_123',
      });

      expect(mockSupabase.storage.from).toHaveBeenCalledWith('custom-customer-bucket');
      expect(mockStorageBucket.upload).toHaveBeenCalledWith(
        `customers/${customerId}/aadhaar/${verificationId}.xml`,
        expect.any(Buffer),
        expect.objectContaining({ contentType: 'application/xml', upsert: true })
      );
      expect(mockVerificationRepo.updateVerification).toHaveBeenCalledWith(
        verificationId,
        expect.objectContaining({
          verificationStatus: AADHAAR_VERIFICATION_STATUS.VERIFIED,
          storageBucket: 'custom-customer-bucket',
          storagePath: `customers/${customerId}/aadhaar/${verificationId}.xml`,
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

    it('successfully processes callback when Sandbox returns status succeeded (documented terminal success)', async () => {
      mockDigiLocker.isSandboxCoInMode.mockReturnValue(true);
      mockDigiLocker.getSessionStatus = jest.fn().mockResolvedValue({
        status: 'succeeded',
        state: 'COMPLETED',
        isAuthorized: true,
        isCompleted: true,
        documentsConsented: ['aadhaar'],
      });

      const result = await service.handleCallback({
        state: sampleState,
        sessionId: 'digilocker_ref_123',
      });

      expect(result.status).toBe(AADHAAR_VERIFICATION_STATUS.VERIFIED);
      expect(result.maskedAadhaar).toBe('XXXX-XXXX-1234');
      expect(mockDigiLocker.fetchAadhaarXml).toHaveBeenCalledWith({
        sessionId: 'digilocker_ref_123',
      });
    });

    it('rejects callback when Sandbox returns status failed and marks verification FAILED', async () => {
      mockDigiLocker.isSandboxCoInMode.mockReturnValue(true);
      mockDigiLocker.getSessionStatus = jest.fn().mockResolvedValue({
        status: 'failed',
        state: 'FAILED',
        isFailed: true,
        isAuthorized: false,
        isCompleted: false,
      });

      await expect(
        service.handleCallback({
          state: sampleState,
          sessionId: 'digilocker_ref_123',
        })
      ).rejects.toThrow(BadRequestError);

      expect(mockVerificationRepo.updateVerification).toHaveBeenCalledWith(
        verificationId,
        expect.objectContaining({
          verificationStatus: AADHAAR_VERIFICATION_STATUS.FAILED,
        })
      );
    });

    it('rejects callback when Sandbox reports session has expired and marks verification EXPIRED', async () => {
      mockDigiLocker.isSandboxCoInMode.mockReturnValue(true);
      mockDigiLocker.getSessionStatus = jest.fn().mockResolvedValue({
        status: 'expired',
        state: 'EXPIRED',
        isExpired: true,
        isAuthorized: false,
        isCompleted: false,
      });

      await expect(
        service.handleCallback({
          state: sampleState,
          sessionId: 'digilocker_ref_123',
        })
      ).rejects.toThrow(BadRequestError);

      expect(mockVerificationRepo.updateVerification).toHaveBeenCalledWith(
        verificationId,
        expect.objectContaining({
          verificationStatus: AADHAAR_VERIFICATION_STATUS.EXPIRED,
        })
      );
    });

    it('rejects callback when Sandbox documents_consented does not include aadhaar', async () => {
      mockDigiLocker.isSandboxCoInMode.mockReturnValue(true);
      mockDigiLocker.getSessionStatus = jest.fn().mockResolvedValue({
        status: 'succeeded',
        state: 'COMPLETED',
        isAuthorized: true,
        isCompleted: true,
        documentsConsented: ['pan', 'driving_license'], // Missing 'aadhaar'
      });

      await expect(
        service.handleCallback({
          state: sampleState,
          sessionId: 'digilocker_ref_123',
        })
      ).rejects.toThrow(BadRequestError);

      expect(mockVerificationRepo.updateVerification).toHaveBeenCalledWith(
        verificationId,
        expect.objectContaining({
          verificationStatus: AADHAAR_VERIFICATION_STATUS.FAILED,
        })
      );
    });

    it('does not mark customer VERIFIED when document fetch fails despite succeeded authorization', async () => {
      mockDigiLocker.isSandboxCoInMode.mockReturnValue(true);
      mockDigiLocker.getSessionStatus = jest.fn().mockResolvedValue({
        status: 'succeeded',
        state: 'COMPLETED',
        isAuthorized: true,
        isCompleted: true,
      });
      mockDigiLocker.fetchAadhaarXml.mockRejectedValue(new BadRequestError('XML download failed', 'DOWNLOAD_FAIL'));

      await expect(
        service.handleCallback({
          state: sampleState,
          sessionId: 'digilocker_ref_123',
        })
      ).rejects.toThrow(BadRequestError);

      expect(mockVerificationRepo.updateVerification).toHaveBeenCalledWith(
        verificationId,
        expect.objectContaining({
          verificationStatus: AADHAAR_VERIFICATION_STATUS.FAILED,
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

    it('handles bucket missing error (Bucket not found, 404) preserving internal cause', async () => {
      const bucketError = { message: 'Bucket not found', statusCode: 404, error: 'Bucket not found' };
      mockStorageBucket.upload.mockResolvedValue({ data: null, error: bucketError });

      let caughtErr;
      try {
        await service.handleCallback({
          state: sampleState,
          code: 'valid_auth_code_123',
        });
      } catch (err) {
        caughtErr = err;
      }

      expect(caughtErr).toBeDefined();
      expect(caughtErr.message).toBe('Failed to persist identity document to secure storage');
      expect(caughtErr.code).toBe('STORAGE_UPLOAD_ERROR');
      expect(caughtErr.cause).toEqual(bucketError);
      expect(caughtErr.httpStatus).toBe(404);

      // Verify DB record marked FAILED and audit event recorded
      expect(mockVerificationRepo.updateVerification).toHaveBeenCalledWith(
        verificationId,
        expect.objectContaining({
          verificationStatus: AADHAAR_VERIFICATION_STATUS.FAILED,
          errorDetails: expect.objectContaining({
            reason: 'Storage upload failed',
            storageErrorCode: 'Bucket not found',
          }),
        })
      );
      expect(mockVerificationRepo.createAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: AUDIT_EVENT_TYPES.VERIFICATION_FAILED,
          details: expect.objectContaining({ step: 'STORAGE_UPLOAD' }),
        })
      );
    });

    it('handles storage client unavailable without skipping upload or marking as VERIFIED', async () => {
      const brokenService = new AadhaarVerificationService({
        customerRepo: mockCustomerRepo,
        documentRepo: mockDocumentRepo,
        verificationRepo: mockVerificationRepo,
        digilocker: mockDigiLocker,
        redis: mockRedis,
        supabase: () => ({ storage: null }), // storage client missing
      });

      await expect(
        brokenService.handleCallback({
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

    it('does not mark customer VERIFIED if database persistence fails after upload', async () => {
      mockVerificationRepo.updateVerification.mockRejectedValueOnce(new Error('Database write constraint failed'));

      await expect(
        service.handleCallback({
          state: sampleState,
          code: 'valid_auth_code_123',
        })
      ).rejects.toThrow('Database write constraint failed');

      // Customer document creation must not have been reached
      expect(mockDocumentRepo.create).not.toHaveBeenCalled();
    });
  });

  describe('3. XML Structure Validation & Data Sanitization', () => {
    it('normalizes documented Sandbox session status values accurately', () => {
      // Completed / Authorized states
      expect(DigiLockerProvider.normalizeSandboxSessionStatus('succeeded')).toEqual(
        expect.objectContaining({ state: 'COMPLETED', isAuthorized: true, isPending: false, isFailed: false, isExpired: false })
      );
      expect(DigiLockerProvider.normalizeSandboxSessionStatus('authorized')).toEqual(
        expect.objectContaining({ state: 'COMPLETED', isAuthorized: true })
      );
      expect(DigiLockerProvider.normalizeSandboxSessionStatus('completed')).toEqual(
        expect.objectContaining({ state: 'COMPLETED', isAuthorized: true })
      );

      // Pending states
      expect(DigiLockerProvider.normalizeSandboxSessionStatus('created')).toEqual(
        expect.objectContaining({ state: 'PENDING', isAuthorized: false, isPending: true })
      );
      expect(DigiLockerProvider.normalizeSandboxSessionStatus('initialized')).toEqual(
        expect.objectContaining({ state: 'PENDING', isAuthorized: false, isPending: true })
      );

      // Failed states
      expect(DigiLockerProvider.normalizeSandboxSessionStatus('failed')).toEqual(
        expect.objectContaining({ state: 'FAILED', isAuthorized: false, isFailed: true })
      );
      expect(DigiLockerProvider.normalizeSandboxSessionStatus('cancelled')).toEqual(
        expect.objectContaining({ state: 'FAILED', isAuthorized: false, isFailed: true })
      );

      // Expired states
      expect(DigiLockerProvider.normalizeSandboxSessionStatus('expired')).toEqual(
        expect.objectContaining({ state: 'EXPIRED', isAuthorized: false, isExpired: true })
      );

      // Null, empty, unknown
      expect(DigiLockerProvider.normalizeSandboxSessionStatus(null)).toEqual(
        expect.objectContaining({ state: 'UNKNOWN', isAuthorized: false })
      );
      expect(DigiLockerProvider.normalizeSandboxSessionStatus('unknown_weird_status')).toEqual(
        expect.objectContaining({ state: 'UNKNOWN', isAuthorized: false })
      );
    });

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

    it('extracts identity info including verified name from valid Aadhaar XML', () => {
      const info = AadhaarVerificationService.extractIdentityInfoFromXml(validAadhaarXml);
      expect(info.verifiedName).toBe('Test User');
      expect(info.dob).toBe('01-01-1990');
      expect(info.gender).toBe('M');
      expect(info.maskedAadhaar).toBe('XXXX-XXXX-1234');
    });

    it('extracts identity info from Sandbox printLetterBarcodeData format', () => {
      const sandboxXml = `<?xml version="1.0" encoding="UTF-8"?><PrintLetterBarcodeData uid="XXXXXXXX5678" name="Rahul Sharma" dob="15-08-1985" gender="M"/>`;
      const info = AadhaarVerificationService.extractIdentityInfoFromXml(sandboxXml);
      expect(info.verifiedName).toBe('Rahul Sharma');
      expect(info.dob).toBe('15-08-1985');
      expect(info.gender).toBe('M');
      expect(info.maskedAadhaar).toBe('XXXX-XXXX-5678');
    });

    it('throws AADHAAR_MISSING_POI when Poi element is missing from XML', () => {
      const noPoiXml = `<?xml version="1.0" encoding="UTF-8"?><UidData uid="XXXXXXXX1234"><Poa co="Care of" /></UidData>`;
      expect(() => AadhaarVerificationService.extractIdentityInfoFromXml(noPoiXml)).toThrow(BadRequestError);
      expect(() => AadhaarVerificationService.extractIdentityInfoFromXml(noPoiXml)).toThrow('Missing <Poi> element');
    });

    it('throws AADHAAR_MISSING_NAME when name attribute is empty or whitespace', () => {
      const emptyNameXml = `<?xml version="1.0" encoding="UTF-8"?><UidData uid="XXXXXXXX1234"><Poi name="   " dob="01-01-1990" gender="F"/></UidData>`;
      expect(() => AadhaarVerificationService.extractIdentityInfoFromXml(emptyNameXml)).toThrow(BadRequestError);
      expect(() => AadhaarVerificationService.extractIdentityInfoFromXml(emptyNameXml)).toThrow('Missing or empty name attribute');
    });

    it('prevents XXE injection and rejects payloads containing external entities', () => {
      const xxeXml = `<?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
        <UidData uid="XXXXXXXX1234">
          <Poi name="&xxe;" dob="01-01-1990" gender="F"/>
        </UidData>`;
      expect(() => AadhaarVerificationService.extractIdentityInfoFromXml(xxeXml)).toThrow(BadRequestError);
      expect(() => AadhaarVerificationService.extractIdentityInfoFromXml(xxeXml)).toThrow('External entities are not supported');
    });

    it('computes deterministic HMAC-SHA256 identity hash with normalization', () => {
      const hash1 = AadhaarVerificationService.computeIdentityHash({
        uid: 'XXXXXXXX1234',
        dob: '01-01-1990',
        gender: 'F',
        verifiedName: 'Jane Doe',
      });
      const hash2 = AadhaarVerificationService.computeIdentityHash({
        uid: 'XXXXXXXX1234',
        dob: '01-01-1990',
        gender: 'f',
        verifiedName: '  Jane   Doe  ',
      });
      expect(hash1).toHaveLength(64);
      expect(hash1).toBe(hash2);
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
        storageBucket: 'gongo-customers',
        storagePath: `customers/${customerId}/aadhaar/${verificationId}.xml`,
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
        storagePath: `customers/${otherCustomerId}/aadhaar/${verificationId}.xml`,
      });

      await expect(service.getSignedDocumentUrl(customerId, verificationId)).rejects.toThrow(ForbiddenError);
    });
  });

  describe('5. Identity Uniqueness & Profile Synchronization', () => {
    beforeEach(() => {
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

    it('synchronizes customer profile name on successful callback', async () => {
      await service.handleCallback({
        state: sampleState,
        code: 'valid_auth_code_123',
      });

      expect(mockCustomerRepo.updateProfile).toHaveBeenCalledWith(
        customerId,
        expect.objectContaining({ name: 'Test User' })
      );
    });

    it('rejects callback with 409 Conflict when Aadhaar identity is already linked to another customer', async () => {
      mockVerificationRepo.findIdentityLinkByHash.mockResolvedValueOnce({
        customer_id: otherCustomerId,
        identity_hash: 'existing_hash_123',
      });

      await expect(
        service.handleCallback({
          state: sampleState,
          code: 'valid_auth_code_123',
        })
      ).rejects.toThrow(ConflictError);

      expect(mockCustomerRepo.updateProfile).not.toHaveBeenCalled();
      expect(mockVerificationRepo.updateVerification).toHaveBeenCalledWith(
        verificationId,
        expect.objectContaining({
          verificationStatus: AADHAAR_VERIFICATION_STATUS.FAILED,
          errorDetails: expect.objectContaining({
            reason: 'IDENTITY_ALREADY_LINKED',
          }),
        })
      );
    });

    it('allows re-verification when Aadhaar identity is linked to the same customer', async () => {
      mockVerificationRepo.findIdentityLinkByHash.mockResolvedValueOnce({
        customer_id: customerId, // Same customer!
        identity_hash: 'existing_hash_123',
      });

      const result = await service.handleCallback({
        state: sampleState,
        code: 'valid_auth_code_123',
      });

      expect(result.status).toBe(AADHAAR_VERIFICATION_STATUS.VERIFIED);
      expect(mockVerificationRepo.upsertIdentityLink).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId,
          verificationId,
        })
      );
    });

    it('cleans up reserved identity link when storage upload fails', async () => {
      mockStorageBucket.upload.mockResolvedValueOnce({
        data: null,
        error: { message: 'Storage network timeout' },
      });

      await expect(
        service.handleCallback({
          state: sampleState,
          code: 'valid_auth_code_123',
        })
      ).rejects.toThrow(ServiceUnavailableError);

      expect(mockVerificationRepo.deleteIdentityLinkByVerificationId).toHaveBeenCalledWith(verificationId);
    });
  });

  describe('6. 12-Digit Aadhaar Availability & Fingerprint Verification', () => {
    it('normalizes valid 12-digit Aadhaar input and rejects malformed formats', () => {
      expect(AadhaarVerificationService.normalizeAadhaarNumber('5421 8976 3412')).toBe('542189763412');
      expect(AadhaarVerificationService.normalizeAadhaarNumber('5421-8976-3412')).toBe('542189763412');

      // Invalid lengths or characters
      expect(() => AadhaarVerificationService.normalizeAadhaarNumber('12345')).toThrow(BadRequestError);
      expect(() => AadhaarVerificationService.normalizeAadhaarNumber('1234567890123')).toThrow(BadRequestError);
      expect(() => AadhaarVerificationService.normalizeAadhaarNumber('5421ABCD3412')).toThrow(BadRequestError);
      expect(() => AadhaarVerificationService.normalizeAadhaarNumber('')).toThrow(BadRequestError);
      expect(() => AadhaarVerificationService.normalizeAadhaarNumber(null)).toThrow(BadRequestError);

      // Repetitive patterns
      expect(() => AadhaarVerificationService.normalizeAadhaarNumber('000000000000')).toThrow(BadRequestError);
      expect(() => AadhaarVerificationService.normalizeAadhaarNumber('111111111111')).toThrow(BadRequestError);
    });

    it('computes deterministic keyed HMAC fingerprint and fails safely when secret is missing', () => {
      const fp1 = AadhaarVerificationService.computeAadhaarFingerprint('542189763412', 'test-secret-key-1');
      const fp2 = AadhaarVerificationService.computeAadhaarFingerprint('542189763412', 'test-secret-key-1');
      const fpOther = AadhaarVerificationService.computeAadhaarFingerprint('987654321098', 'test-secret-key-1');

      expect(fp1).toHaveLength(64);
      expect(fp1).toBe(fp2);
      expect(fp1).not.toBe(fpOther);

      // Fails safely if secret is missing or empty
      expect(() => AadhaarVerificationService.computeAadhaarFingerprint('542189763412', '')).toThrow(ServiceUnavailableError);
      expect(() => AadhaarVerificationService.computeAadhaarFingerprint('542189763412', null)).toThrow(ServiceUnavailableError);
    });

    it('confirms availability when identity is unlinked', async () => {
      mockVerificationRepo.findIdentityLinkByHash.mockResolvedValueOnce(null);
      mockVerificationRepo.query.mockResolvedValueOnce({ rows: [] });

      const res = await service.checkAadhaarAvailability(customerId, '5421 8976 3412');
      expect(res.isAvailable).toBe(true);
      expect(res.message).toBe('Aadhaar is available for verification.');
      // Never exposes raw Aadhaar or fingerprint
      expect(res).not.toHaveProperty('identityHash');
      expect(res).not.toHaveProperty('aadhaarNumber');
    });

    it('allows availability when identity is already linked to the SAME customer (re-verification)', async () => {
      mockVerificationRepo.findIdentityLinkByHash.mockResolvedValueOnce({
        customer_id: customerId,
        identity_hash: 'mock_fingerprint_hex',
      });

      const res = await service.checkAadhaarAvailability(customerId, '5421 8976 3412');
      expect(res.isAvailable).toBe(true);
      expect(res.message).toBe('Aadhaar is available for verification.');
    });

    it('blocks availability when identity is already linked to ANOTHER customer', async () => {
      mockVerificationRepo.findIdentityLinkByHash.mockResolvedValueOnce({
        customer_id: otherCustomerId,
        identity_hash: 'mock_fingerprint_hex',
      });

      const res = await service.checkAadhaarAvailability(customerId, '5421 8976 3412');
      expect(res.isAvailable).toBe(false);
      expect(res.reason).toBe('IDENTITY_ALREADY_LINKED');
      expect(res.message).toBe('This Aadhaar is already associated with a verified account.');
      // Does NOT reveal the other customer ID
      expect(res).not.toHaveProperty('customerId');
      expect(res).not.toHaveProperty('otherCustomerId');
    });

    it('rejects initiation when entered Aadhaar is already linked to another customer', async () => {
      mockVerificationRepo.findIdentityLinkByHash.mockResolvedValueOnce({
        customer_id: otherCustomerId,
        identity_hash: 'mock_fingerprint_hex',
      });

      await expect(
        service.initiateVerification(customerId, { aadhaarNumber: '5421 8976 3412' })
      ).rejects.toThrow(ConflictError);
    });

    it('rejects callback with AADHAAR_IDENTITY_MISMATCH if XML last 4 digits do not match entered number', async () => {
      mockVerificationRepo.findById.mockResolvedValueOnce({
        id: verificationId,
        customerId,
        verificationStatus: AADHAAR_VERIFICATION_STATUS.IN_PROGRESS,
        provider: AADHAAR_PROVIDERS.DIGILOCKER_SANDBOX,
        identityHash: null,
        consentRecord: {
          last4: '3412', // Customer entered number ending in 3412
        },
      });

      mockDigiLocker.fetchAadhaarXml.mockResolvedValueOnce({
        xmlContent: `<?xml version="1.0" encoding="UTF-8"?>
          <UidData uid="XXXXXXXX9999">
            <Poi name="Mismatched Person" dob="01-01-1990" gender="M"/>
          </UidData>`,
        documentType: 'AADHAAR',
        isAuthorized: true,
      });

      await expect(
        service.handleCallback({
          state: sampleState,
          code: 'mismatch_code_123',
        })
      ).rejects.toThrow(BadRequestError);
    });
  });
});
