'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const vehicleRepository = require('../../src/repositories/vehicle.repository');
const vehicleService = require('../../src/services/vehicle.service');
const pool = require('../../src/db/pool');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Step 3 Integration: Vehicle Documents, Verification & Authority Hardening', () => {
  let app;
  let mockAuth;

  const partner1Id = '11111111-1111-1111-1111-111111111111';
  const partner2Id = '22222222-2222-2222-2222-222222222222';
  const vehicle1Id = 'aaaa1111-1111-1111-1111-111111111111';
  const vehicle2Id = 'bbbb2222-2222-2222-2222-222222222222';
  const doc1Id = 'dddd1111-1111-1111-1111-111111111111';
  const doc2Id = 'dddd2222-2222-2222-2222-222222222222';

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();

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
  });

  describe('1. Authority Hardening & Document Submission', () => {
    it('A. Partner submits RC -> created with status PENDING', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        brand: 'Hyundai',
        model: 'Creta',
        verification_status: 'PENDING',
      });

      jest.spyOn(vehicleRepository, 'findMaxDocumentVersion').mockResolvedValue(0);

      const storageKey = `partners/${partner1Id}/vehicles/${vehicle1Id}/documents/rc/rc.pdf`;

      jest.spyOn(vehicleRepository, 'createVehicleDocument').mockResolvedValue({
        id: doc1Id,
        vehicle_id: vehicle1Id,
        document_type: 'RC',
        storage_key: storageKey,
        verification_status: 'PENDING',
        version: 1,
        created_at: new Date().toISOString(),
      });

      const res = await request(app)
        .post('/api/v1/partner/vehicle-documents')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          vehicleId: vehicle1Id,
          documentType: 'RC',
          storageKey,
          documentNumber: 'DL01AB1234',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.documentType).toBe('RC');
      expect(res.body.data.verificationStatus).toBe('PENDING');
      expect(res.body.data.version).toBe(1);
    });

    it('B. Partner submits Insurance -> created with status PENDING', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        brand: 'Hyundai',
        model: 'Creta',
        verification_status: 'PENDING',
      });

      jest.spyOn(vehicleRepository, 'findMaxDocumentVersion').mockResolvedValue(0);

      const storageKey = `partners/${partner1Id}/vehicles/${vehicle1Id}/documents/insurance/ins.pdf`;

      jest.spyOn(vehicleRepository, 'createVehicleDocument').mockResolvedValue({
        id: doc2Id,
        vehicle_id: vehicle1Id,
        document_type: 'Insurance',
        storage_key: storageKey,
        verification_status: 'PENDING',
        version: 1,
        created_at: new Date().toISOString(),
      });

      const res = await request(app)
        .post(`/api/v1/partner/vehicles/${vehicle1Id}/documents`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          documentType: 'Insurance',
          storageKey,
          documentNumber: 'POL-999888',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.documentType).toBe('Insurance');
      expect(res.body.data.verificationStatus).toBe('PENDING');
    });

    it('C & D. Rejects client attempt to inject protected verification fields (Mass Assignment)', async () => {
      const basePayload = {
        vehicleId: vehicle1Id,
        documentType: 'RC',
        storageKey: `partners/${partner1Id}/vehicles/${vehicle1Id}/documents/rc/rc.pdf`,
      };

      const maliciousFields = [
        { status: 'APPROVED' },
        { verificationStatus: 'VERIFIED' },
        { verified: true },
        { isVerified: true },
        { approved: true },
        { isApproved: true },
        { valid: true },
        { isValid: true },
        { rejected: true },
        { isRejected: true },
        { verifiedAt: new Date().toISOString() },
        { verified_at: new Date().toISOString() },
        { verifiedBy: 'admin-uuid' },
        { reviewerId: 'admin-uuid' },
        { adminNotes: 'Bypass verification' },
        { approvalTimestamp: new Date().toISOString() },
      ];

      for (const malicious of maliciousFields) {
        const res = await request(app)
          .post('/api/v1/partner/vehicle-documents')
          .set('Authorization', 'Bearer partner-1-token')
          .send({ ...basePayload, ...malicious });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('MASS_ASSIGNMENT_VIOLATION');
      }
    });

    it('Accepts FITNESS_CERTIFICATE as a valid canonical document type', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        brand: 'Hyundai',
        model: 'Creta',
        verification_status: 'PENDING',
      });

      jest.spyOn(vehicleRepository, 'findMaxDocumentVersion').mockResolvedValue(0);

      const storageKey = `partners/${partner1Id}/vehicles/${vehicle1Id}/documents/fitness/fit.pdf`;

      jest.spyOn(vehicleRepository, 'createVehicleDocument').mockResolvedValue({
        id: 'dddd5555-5555-5555-5555-555555555555',
        vehicle_id: vehicle1Id,
        document_type: 'FITNESS_CERTIFICATE',
        storage_key: storageKey,
        document_number: 'FIT-12345',
        valid_till: '2028-10-01',
        verification_status: 'PENDING',
        version: 1,
        created_at: new Date().toISOString(),
      });

      const res = await request(app)
        .post('/api/v1/partner/vehicle-documents')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          vehicleId: vehicle1Id,
          documentType: 'FITNESS_CERTIFICATE',
          storageKey,
          documentNumber: 'FIT-12345',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.documentType).toBe('FITNESS_CERTIFICATE');
      expect(res.body.data.verificationStatus).toBe('PENDING');
      expect(res.body.data.partnerSubmittedMetadata).toBeDefined();
      expect(res.body.data.partnerSubmittedMetadata.isAuthoritative).toBe(false);
      expect(res.body.data.partnerSubmittedMetadata.documentNumber).toBe('FIT-12345');
    });

    it('Rejects arbitrary document types outside canonical taxonomy', async () => {
      const res = await request(app)
        .post('/api/v1/partner/vehicle-documents')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          vehicleId: vehicle1Id,
          documentType: 'FAKE_PASSPORT_TYPE',
          storageKey: `partners/${partner1Id}/vehicles/${vehicle1Id}/documents/fake.pdf`,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('E. Partner cannot upload document to another partner\'s vehicle (BOLA check)', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue(null);

      const res = await request(app)
        .post('/api/v1/partner/vehicle-documents')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          vehicleId: vehicle2Id, // Owned by partner 2
          documentType: 'RC',
          storageKey: `partners/${partner1Id}/vehicles/${vehicle2Id}/documents/rc.pdf`,
        });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('F. Partner cannot access admin approval routes on partner endpoints', async () => {
      const res = await request(app)
        .post(`/api/v1/partner/vehicle-documents/${doc1Id}/approve`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({});

      expect(res.status).toBe(404);
    });

    it('L. Partner cannot view another partner\'s vehicle document (BOLA)', async () => {
      jest.spyOn(vehicleRepository, 'findVehicleDocumentByIdOnly').mockResolvedValue({
        id: doc1Id,
        vehicle_id: vehicle2Id,
        partner_id: partner2Id, // Owned by Partner 2
        document_type: 'RC',
        verification_status: 'PENDING',
      });

      const res = await request(app)
        .get(`/api/v1/partner/vehicle-documents/${doc1Id}`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('2. Vehicle Verification & Listing Eligibility Enforcement', () => {
    // Product invariant (owner decision): an unverified/PENDING vehicle must not become ONLINE,
    // whichever request key is used. Previously this asserted 200 via the `manualStatus` key,
    // which was a bypass of the `status`-key gate (see step6 "strictly forbids PENDING").
    it('J. Rejected (REJECTED) vehicle CANNOT be brought ONLINE by partner, even via the manualStatus key', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        brand: 'Hyundai',
        model: 'Creta',
        verification_status: 'REJECTED',
        manual_status: 'OFFLINE',
        effective_status: 'UNAVAILABLE',
        active_booking_id: null,
      });

      const updateSpy = jest.spyOn(vehicleRepository, 'updateStatus').mockResolvedValue({});

      const res = await request(app)
        .patch(`/api/v1/partner/vehicles/${vehicle1Id}/status`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          manualStatus: 'ONLINE',
        });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toMatch(/rejected/i);
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('J. Effective status is AVAILABLE for unverified vehicle when manual_status is ONLINE and rental_status is IDLE', () => {
      const unverifiedVehicle = {
        verification_status: 'PENDING',
        manual_status: 'ONLINE',
        rental_status: 'IDLE',
        is_active: true,
        active_booking_id: null,
      };

      const effective = vehicleService.calculateEffectiveStatus(unverifiedVehicle);
      expect(effective).toBe('AVAILABLE');
    });

    it('K. Effective status becomes AVAILABLE when verified, active, and manual ONLINE without active bookings', () => {
      const verifiedVehicle = {
        verification_status: 'VERIFIED',
        manual_status: 'ONLINE',
        rental_status: 'IDLE',
        is_active: true,
        active_booking_id: null,
      };

      const effective = vehicleService.calculateEffectiveStatus(verifiedVehicle);
      expect(effective).toBe('AVAILABLE');
    });
  });

  describe('3. Resubmission & Versioning Workflow', () => {
    it('I. Resubmission of rejected document creates version 2 in PENDING status', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        brand: 'Hyundai',
        model: 'Creta',
        verification_status: 'PENDING',
      });

      // Existing rejected document was version 1
      jest.spyOn(vehicleRepository, 'findMaxDocumentVersion').mockResolvedValue(1);

      const storageKey = `partners/${partner1Id}/vehicles/${vehicle1Id}/documents/rc/rc_v2.pdf`;

      let createdVersion = null;
      let createdStatus = null;
      jest.spyOn(vehicleRepository, 'createVehicleDocument').mockImplementation(async (params) => {
        createdVersion = params.version;
        createdStatus = params.verificationStatus;
        return {
          id: 'dddd3333-3333-3333-3333-333333333333',
          vehicle_id: vehicle1Id,
          document_type: params.documentType,
          storage_key: params.storageKey,
          verification_status: params.verificationStatus,
          version: params.version,
          created_at: new Date().toISOString(),
        };
      });

      const res = await request(app)
        .post('/api/v1/partner/vehicle-documents')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          vehicleId: vehicle1Id,
          documentType: 'RC',
          storageKey,
          documentNumber: 'DL01AB1234',
        });

      expect(res.status).toBe(201);
      expect(createdVersion).toBe(2);
      expect(createdStatus).toBe('PENDING');
      expect(res.body.data.version).toBe(2);
      expect(res.body.data.verificationStatus).toBe('PENDING');
    });
  });

  describe('4. Inline Document Creation Mass Assignment Protection', () => {
    it('Rejects createVehicle with inline document having verified: true or status: APPROVED', async () => {
      const res = await request(app)
        .post('/api/v1/partner/vehicles')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          brand: 'Tata',
          model: 'Nexon',
          registrationNumber: 'DL01XY9999',
          category: 'Car',
          fuelType: 'Petrol',
          transmission: 'Automatic',
          year: 2023,
          seats: 5,
          pickupLocation: 'Delhi Hub',
          pricePerDay: 2500,
          securityDeposit: 3000,
          documents: [
            {
              documentType: 'RC',
              storageKey: 'rc.pdf',
              verified: true,
            },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MASS_ASSIGNMENT_VIOLATION');
    });
  });

  describe('5. Storage Presigned Upload Security for Documents', () => {
    it('Rejects presign if client injects verified: true or status: APPROVED', async () => {
      const res = await request(app)
        .post('/api/v1/partner/storage/presign')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          entityType: 'VEHICLE_DOCUMENT',
          vehicleId: vehicle1Id,
          documentType: 'RC',
          fileName: 'rc.pdf',
          contentType: 'application/pdf',
          verified: true,
          status: 'APPROVED',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MASS_ASSIGNMENT_VIOLATION');
    });

    it('Rejects presign if vehicleId is missing for VEHICLE_DOCUMENT', async () => {
      const res = await request(app)
        .post('/api/v1/partner/storage/presign')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          entityType: 'VEHICLE_DOCUMENT',
          documentType: 'RC',
          fileName: 'rc.pdf',
          contentType: 'application/pdf',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/vehicleId is required/i);
    });

    it('Rejects presign if vehicle belongs to another partner (BOLA)', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue(null);

      const res = await request(app)
        .post('/api/v1/partner/storage/presign')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          entityType: 'VEHICLE_DOCUMENT',
          vehicleId: vehicle2Id, // Owned by Partner 2
          documentType: 'RC',
          fileName: 'rc.pdf',
          contentType: 'application/pdf',
        });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });
});
