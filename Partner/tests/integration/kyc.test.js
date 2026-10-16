'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const PartnerDocumentRepository = require('../../src/repositories/partnerDocument.repository');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Integration: KYC Overview & Document Metadata API', () => {
  let app;
  let mockAuth;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    mockAuth = {
      verifyIdToken: jest.fn(async (token) => {
        if (token === 'partner-token') {
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
      if (idOrAuth === 'uid-partner-1' || idOrAuth === 'partner-123') {
        return {
          id: 'partner-123',
          partnerId: 'partner-123',
          userId: 'user-123',
          auth_id: 'uid-partner-1',
          role: 'PARTNER',
          is_active: true,
          partner_status: 'OFFLINE',
          kyc_status: 'PENDING',
        };
      }
      if (idOrAuth === 'uid-partner-2' || idOrAuth === 'partner-456') {
        return {
          id: 'partner-456',
          partnerId: 'partner-456',
          userId: 'user-456',
          auth_id: 'uid-partner-2',
          role: 'PARTNER',
          is_active: true,
          partner_status: 'OFFLINE',
          kyc_status: 'PENDING',
        };
      }
      return null;
    });
  });

  afterEach(() => {
    PartnerRepository.setMockPartnerResolver(null);
    jest.restoreAllMocks();
  });

  describe('GET /api/v1/partner/kyc', () => {
    it('returns KYC overview with masked document numbers and requirement lists', async () => {
      jest.spyOn(PartnerDocumentRepository.prototype, 'findLatestByPartnerId').mockResolvedValue([
        {
          id: 'doc-aadhaar-1',
          partner_id: 'partner-123',
          document_type: 'AADHAAR',
          document_number: '123456788910',
          verification_status: 'VERIFIED',
          version: 1,
          rejection_reason: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]);

      const res = await request(app)
        .get('/api/v1/partner/kyc')
        .set('Authorization', 'Bearer partner-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.kycStatus).toBe('PENDING');
      expect(res.body.data.documents).toHaveLength(1);
      expect(res.body.data.documents[0].documentNumberMasked).toBe('•••• •••• 8910');
      expect(res.body.data.documents[0].documentNumber).toBeUndefined(); // Raw number never exposed
      expect(res.body.data.requiredDocumentTypes).toContain('AADHAAR');
    });
  });

  describe('POST /api/v1/partner/kyc/documents', () => {
    it('submits document metadata, starts at version 1, enforces PENDING status', async () => {
      jest.spyOn(PartnerDocumentRepository.prototype, 'findMaxVersion').mockResolvedValue(0);
      jest.spyOn(PartnerDocumentRepository.prototype, 'createDocument').mockResolvedValue({
        id: 'new-doc-1',
        partner_id: 'partner-123',
        document_type: 'AADHAAR',
        document_number: '123456788910',
        storage_key: 'kyc-documents/partner-123/aadhaar_v1',
        verification_status: 'PENDING',
        version: 1,
        created_at: new Date().toISOString(),
      });

      const res = await request(app)
        .post('/api/v1/partner/kyc/documents')
        .set('Authorization', 'Bearer partner-token')
        .send({
          documentType: 'AADHAAR',
          documentNumber: '123456788910',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.version).toBe(1);
      expect(res.body.data.verificationStatus).toBe('PENDING');
      expect(res.body.data.documentNumberMasked).toBe('•••• •••• 8910');
    });

    it('increments version to 2 when a document of same type already exists', async () => {
      jest.spyOn(PartnerDocumentRepository.prototype, 'findMaxVersion').mockResolvedValue(1);
      jest.spyOn(PartnerDocumentRepository.prototype, 'createDocument').mockResolvedValue({
        id: 'new-doc-2',
        partner_id: 'partner-123',
        document_type: 'AADHAAR',
        document_number: '987654321098',
        storage_key: 'kyc-documents/partner-123/aadhaar_v2',
        verification_status: 'PENDING',
        version: 2,
        created_at: new Date().toISOString(),
      });

      const res = await request(app)
        .post('/api/v1/partner/kyc/documents')
        .set('Authorization', 'Bearer partner-token')
        .send({
          documentType: 'AADHAAR',
          documentNumber: '987654321098',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.version).toBe(2);
    });

    it('rejects client attempts to set verificationStatus = VERIFIED', async () => {
      const res = await request(app)
        .post('/api/v1/partner/kyc/documents')
        .set('Authorization', 'Bearer partner-token')
        .send({
          documentType: 'AADHAAR',
          documentNumber: '123456788910',
          verificationStatus: 'VERIFIED',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
    });

    it('rejects client attempts to set kycStatus = VERIFIED', async () => {
      const res = await request(app)
        .post('/api/v1/partner/kyc/documents')
        .set('Authorization', 'Bearer partner-token')
        .send({
          documentType: 'AADHAAR',
          kycStatus: 'VERIFIED',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
    });

    it('rejects client attempts to inject storageKey', async () => {
      const res = await request(app)
        .post('/api/v1/partner/kyc/documents')
        .set('Authorization', 'Bearer partner-token')
        .send({
          documentType: 'AADHAAR',
          storageKey: 's3://untrusted/fake.pdf',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
    });

    it('rejects unsupported document type', async () => {
      const res = await request(app)
        .post('/api/v1/partner/kyc/documents')
        .set('Authorization', 'Bearer partner-token')
        .send({
          documentType: 'VOTER_ID_UNSUPPORTED',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('documentType must be one of');
    });

    it('rejects malformed Aadhaar number with 400', async () => {
      const res = await request(app)
        .post('/api/v1/partner/kyc/documents')
        .set('Authorization', 'Bearer partner-token')
        .send({
          documentType: 'AADHAAR',
          documentNumber: '12345',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Aadhaar card number must contain exactly 12 digits');
    });
  });

  describe('GET /api/v1/partner/kyc/documents/:id', () => {
    it('returns masked document when owned by authenticated partner', async () => {
      jest.spyOn(PartnerDocumentRepository.prototype, 'findByIdAndPartnerId').mockImplementation(
        async (id, partnerId) => {
          if (id === 'doc-123' && partnerId === 'partner-123') {
            return {
              id: 'doc-123',
              partner_id: 'partner-123',
              document_type: 'PAN',
              document_number: 'ABCDE1234F',
              verification_status: 'PENDING',
              version: 1,
            };
          }
          return null;
        },
      );

      const res = await request(app)
        .get('/api/v1/partner/kyc/documents/doc-123')
        .set('Authorization', 'Bearer partner-token');

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe('doc-123');
      expect(res.body.data.documentNumberMasked).toBe('AB••••••4F');
    });

    it('returns 404 when Partner 2 attempts to access Partner 1 document (IDOR protection)', async () => {
      jest.spyOn(PartnerDocumentRepository.prototype, 'findByIdAndPartnerId').mockImplementation(
        async (id, partnerId) => {
          // doc-123 belongs to partner-123, not partner-456
          if (id === 'doc-123' && partnerId === 'partner-123') {
            return { id: 'doc-123', partner_id: 'partner-123' };
          }
          return null;
        },
      );

      const res = await request(app)
        .get('/api/v1/partner/kyc/documents/doc-123')
        .set('Authorization', 'Bearer partner-2-token');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(ERROR_CODES.NOT_FOUND);
    });
  });
});
