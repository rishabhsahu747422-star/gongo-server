'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const vehicleRepository = require('../../src/repositories/vehicle.repository');
const vehicleService = require('../../src/services/vehicle.service');
const pool = require('../../src/db/pool');
const consentRepository = require('../../src/repositories/consent.repository');
const s3Provider = require('../../src/providers/s3');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Integration: Partner Vehicles / Inventory Management API', () => {
  let app;
  let mockAuth;

  const partner1Id = '11111111-1111-1111-1111-111111111111';
  const partner2Id = '22222222-2222-2222-2222-222222222222';
  const vehicle1Id = 'aaaa1111-1111-1111-1111-111111111111';
  const vehicle2Id = 'bbbb2222-2222-2222-2222-222222222222';
  const imageId = 'cccc3333-3333-3333-3333-333333333333';
  const docId = 'dddd4444-4444-4444-4444-444444444444';

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

  // ── 1. Create Vehicle (POST /api/v1/partner/vehicles) ───────────────
  describe('POST /api/v1/partner/vehicles', () => {
    const validVehiclePayload = {
      category: 'Car',
      brand: 'Maruti Suzuki',
      model: 'Brezza',
      variant: 'ZXI Plus',
      registrationNumber: 'MP 04 ZB 8888',
      year: 2023,
      fuelType: 'Petrol',
      transmission: 'Automatic',
      seats: 5,
      description: 'Compact SUV in excellent condition',
      pickupLocation: 'Platform 1 Counter, Station Road',
      leaseAgreementAccepted: true,
    };

    it('creates vehicle with valid payload and returns 201', async () => {
      jest.spyOn(vehicleRepository, 'findByRegistrationNumber').mockResolvedValue(null);
      jest.spyOn(vehicleService.shopRepository, 'findByPartnerId').mockResolvedValue({ id: 'legacy-shop-1' });
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));
      // Lease consent is persisted inside the creation transaction; stub it since the tx client is a stub
      const recordConsentSpy = jest.spyOn(consentRepository, 'recordConsent').mockResolvedValue({ id: 'consent-1' });
      jest.spyOn(vehicleRepository, 'createVehicle').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        shop_id: 'legacy-shop-1',
        category: 'Car',
        brand: 'Maruti Suzuki',
        model: 'Brezza',
        variant: 'ZXI Plus',
        registration_number: 'MP 04 ZB 8888',
        year: 2023,
        fuel_type: 'Petrol',
        transmission: 'Automatic',
        seats: 5,
        description: 'Compact SUV in excellent condition',
        pickup_location: 'Platform 1 Counter, Station Road',
        manual_status: 'ONLINE',
        rental_status: 'IDLE',
        verification_status: 'VERIFIED',
        is_archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const res = await request(app)
        .post('/api/v1/partner/vehicles')
        .set('Authorization', 'Bearer partner-1-token')
        .send(validVehiclePayload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(vehicle1Id);
      expect(res.body.data.brand).toBe('Maruti Suzuki');
      expect(res.body.data.effectiveStatus).toBe('AVAILABLE');
      expect(res.body.data.shopId).toBe('legacy-shop-1');
      expect(recordConsentSpy).toHaveBeenCalledWith(expect.objectContaining({ vehicleId: vehicle1Id }));
    });

    it('rejects duplicate registration number with 409 Conflict', async () => {
      jest.spyOn(vehicleRepository, 'findByRegistrationNumber').mockResolvedValue({ id: 'existing-id' });

      const res = await request(app)
        .post('/api/v1/partner/vehicles')
        .set('Authorization', 'Bearer partner-1-token')
        .send(validVehiclePayload);

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.CONFLICT);
    });

    it('rejects mass assignment / server-controlled fields with 400', async () => {
      const res = await request(app)
        .post('/api/v1/partner/vehicles')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          ...validVehiclePayload,
          rentalStatus: 'ACTIVE',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
    });

    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(app)
        .post('/api/v1/partner/vehicles')
        .send(validVehiclePayload);

      expect(res.status).toBe(401);
    });
  });

  // ── 2. List Vehicles (GET /api/v1/partner/vehicles) ─────────────────
  describe('GET /api/v1/partner/vehicles', () => {
    it('returns vehicles for authenticated partner with pagination and computed effectiveStatus', async () => {
      jest.spyOn(vehicleRepository, 'findManyByPartnerId').mockResolvedValue([
        {
          id: vehicle1Id,
          partner_id: partner1Id,
          category: 'Car',
          brand: 'Hyundai',
          model: 'Creta',
          registration_number: 'MP 04 XY 1111',
          year: 2022,
          manual_status: 'ONLINE',
          rental_status: 'IDLE',
          is_archived: false,
          cover_image_key: 'partners/creta.jpg',
        },
      ]);
      jest.spyOn(vehicleRepository, 'countByPartnerId').mockResolvedValue(1);

      const res = await request(app)
        .get('/api/v1/partner/vehicles?page=1&limit=10')
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.vehicles).toHaveLength(1);
      expect(res.body.data.vehicles[0].effectiveStatus).toBe('AVAILABLE');
      expect(res.body.data.pagination.total).toBe(1);
    });
  });

  // ── 3. Vehicle Details (GET /api/v1/partner/vehicles/:vehicleId) ────
  describe('GET /api/v1/partner/vehicles/:vehicleId', () => {
    it('returns vehicle details with images and compliance documents', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        category: 'Car',
        brand: 'Hyundai',
        model: 'Creta',
        registration_number: 'MP 04 XY 1111',
        year: 2022,
        manual_status: 'ONLINE',
        rental_status: 'IDLE',
        is_archived: false,
      });
      jest.spyOn(vehicleRepository, 'getVehicleImages').mockResolvedValue([
        {
          id: imageId,
          vehicle_id: vehicle1Id,
          storage_key: 'partners/img.jpg',
          image_url: 'partners/img.jpg',
          sort_order: 0,
          is_cover: true,
        },
      ]);
      jest.spyOn(vehicleRepository, 'getVehicleDocuments').mockResolvedValue([
        {
          id: docId,
          vehicle_id: vehicle1Id,
          document_type: 'RC',
          document_name: 'RC',
          storage_key: 'partners/rc.pdf',
          verification_status: 'VERIFIED',
          version: 1,
        },
      ]);

      const res = await request(app)
        .get(`/api/v1/partner/vehicles/${vehicle1Id}`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(vehicle1Id);
      expect(res.body.data.images).toHaveLength(1);
      expect(res.body.data.documents).toHaveLength(1);
      expect(res.body.data.documents[0].documentType).toBe('RC');
    });

    it('enforces strict BOLA: returns 404 when partner attempts to access another partner vehicle', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/v1/partner/vehicles/${vehicle2Id}`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  // ── 4. Update Vehicle (PATCH /api/v1/partner/vehicles/:vehicleId) ───
  describe('PATCH /api/v1/partner/vehicles/:vehicleId', () => {
    it('updates editable vehicle fields', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        is_archived: false,
      });
      jest.spyOn(vehicleRepository, 'updateVehicle').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        brand: 'Hyundai',
        model: 'Creta SX(O)',
        pickup_location: 'Shop 101, New Counter',
        manual_status: 'ONLINE',
        rental_status: 'IDLE',
        is_archived: false,
      });

      const res = await request(app)
        .patch(`/api/v1/partner/vehicles/${vehicle1Id}`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          model: 'Creta SX(O)',
          pickupLocation: 'Shop 101, New Counter',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.model).toBe('Creta SX(O)');
      expect(res.body.data.pickupLocation).toBe('Shop 101, New Counter');
    });

    it('rejects attempt to change registration number with 400', async () => {
      const res = await request(app)
        .patch(`/api/v1/partner/vehicles/${vehicle1Id}`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          registrationNumber: 'MP 04 NEW 9999',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('registration number cannot be changed');
    });

    it('rejects mass assignment in update with 400', async () => {
      const res = await request(app)
        .patch(`/api/v1/partner/vehicles/${vehicle1Id}`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          rentalStatus: 'BOOKED',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
    });

    it.each([
      { manualStatus: 'ONLINE' },
      { manual_status: 'ONLINE' },
      { status: 'ONLINE' },
      { isAvailable: true },
      { is_available: true },
      { isActive: true },
      { is_active: true },
      { isArchived: false },
      { verificationStatus: 'VERIFIED' },
    ])('the details PATCH cannot change availability/lifecycle fields: %p -> 400, no write', async (body) => {
      const updateSpy = jest.spyOn(vehicleRepository, 'updateVehicle');
      const res = await request(app)
        .patch(`/api/v1/partner/vehicles/${vehicle1Id}`)
        .set('Authorization', 'Bearer partner-1-token')
        .send(body);

      expect(res.status).toBe(400);
      expect(updateSpy).not.toHaveBeenCalled();
    });
  });

  // ── 5. Status Update (PATCH /api/v1/partner/vehicles/:vehicleId/status)
  describe('PATCH /api/v1/partner/vehicles/:vehicleId/status', () => {
    it('sets vehicle status to OFFLINE with reason', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        manual_status: 'ONLINE',
        rental_status: 'IDLE',
        is_archived: false,
      });
      jest.spyOn(vehicleRepository, 'updateStatus').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        manual_status: 'OFFLINE',
        rental_status: 'IDLE',
        offline_reason: 'Brake pad replacement',
        is_archived: false,
      });

      const res = await request(app)
        .patch(`/api/v1/partner/vehicles/${vehicle1Id}/status`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          status: 'OFFLINE',
          reason: 'Brake pad replacement',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.manualStatus).toBe('OFFLINE');
      expect(res.body.data.offlineReason).toBe('Brake pad replacement');
      expect(res.body.data.effectiveStatus).toBe('UNAVAILABLE');
    });

    it('rejects status change with 409 if trip is currently ACTIVE', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        manual_status: 'ONLINE',
        rental_status: 'ACTIVE',
        is_archived: false,
      });

      const res = await request(app)
        .patch(`/api/v1/partner/vehicles/${vehicle1Id}/status`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          status: 'OFFLINE',
        });

      expect(res.status).toBe(409);
      expect(res.body.error.message).toContain('active trip is in progress');
    });

    describe('ONLINE requires an active, non-archived VERIFIED/APPROVED vehicle for every accepted key', () => {
      const vehicleAs = (overrides) => jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        manual_status: 'OFFLINE',
        rental_status: 'IDLE',
        verification_status: 'VERIFIED',
        is_archived: false,
        is_active: true,
        ...overrides,
      });

      it.each([
        ['REJECTED via manualStatus', { verification_status: 'REJECTED' }, { manualStatus: 'ONLINE' }],
        ['blocked via manualStatus', { is_active: false }, { manualStatus: 'ONLINE' }],
        ['archived via status', { is_archived: true, is_active: false }, { status: 'ONLINE' }],
      ])('returns 409 for %s and does not write', async (_label, overrides, body) => {
        vehicleAs(overrides);
        const updateSpy = jest.spyOn(vehicleRepository, 'updateStatus').mockResolvedValue({});

        const res = await request(app)
          .patch(`/api/v1/partner/vehicles/${vehicle1Id}/status`)
          .set('Authorization', 'Bearer partner-1-token')
          .send(body);

        expect(res.status).toBe(409);
        expect(res.body.success).toBe(false);
        expect(updateSpy).not.toHaveBeenCalled();
      });

      it.each([
        ['PENDING via manualStatus', { verification_status: 'PENDING' }, { manualStatus: 'ONLINE' }],
        ['PENDING via status', { verification_status: 'PENDING' }, { status: 'ONLINE' }],
        ['UNDER_REVIEW via manualStatus', { verification_status: 'UNDER_REVIEW' }, { manualStatus: 'online' }],
      ])('allows %s and writes ONLINE', async (_label, overrides, body) => {
        vehicleAs(overrides);
        const updateSpy = jest.spyOn(vehicleRepository, 'updateStatus').mockResolvedValue({
          id: vehicle1Id,
          partner_id: partner1Id,
          manual_status: 'ONLINE',
          rental_status: 'IDLE',
          ...overrides,
        });

        const res = await request(app)
          .patch(`/api/v1/partner/vehicles/${vehicle1Id}/status`)
          .set('Authorization', 'Bearer partner-1-token')
          .send(body);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(updateSpy).toHaveBeenCalled();
      });

      it('rejects snake_case manual_status (not an accepted key) with 400 rather than silently ignoring it', async () => {
        vehicleAs({ verification_status: 'PENDING' });
        const res = await request(app)
          .patch(`/api/v1/partner/vehicles/${vehicle1Id}/status`)
          .set('Authorization', 'Bearer partner-1-token')
          .send({ manual_status: 'ONLINE' });

        expect(res.status).toBe(400);
      });

      it('returns 409 (not silent success) when an admin blocks/rejects between the read and the guarded UPDATE', async () => {
        vehicleAs({});
        jest.spyOn(vehicleRepository, 'updateStatus').mockResolvedValue(null);

        const res = await request(app)
          .patch(`/api/v1/partner/vehicles/${vehicle1Id}/status`)
          .set('Authorization', 'Bearer partner-1-token')
          .send({ manualStatus: 'ONLINE' });

        expect(res.status).toBe(409);
        expect(res.body.success).toBe(false);
      });

      it('returns 200 for an active, non-archived APPROVED vehicle', async () => {
        vehicleAs({ verification_status: 'approved' });
        jest.spyOn(vehicleRepository, 'updateStatus').mockResolvedValue({
          id: vehicle1Id, partner_id: partner1Id, manual_status: 'ONLINE', rental_status: 'IDLE', is_archived: false,
        });

        const res = await request(app)
          .patch(`/api/v1/partner/vehicles/${vehicle1Id}/status`)
          .set('Authorization', 'Bearer partner-1-token')
          .send({ manualStatus: 'ONLINE' });

        expect(res.status).toBe(200);
        expect(res.body.data.manualStatus).toBe('ONLINE');
      });
    });
  });

  // ── 6. Archive Vehicle (DELETE /api/v1/partner/vehicles/:vehicleId) ──
  describe('DELETE /api/v1/partner/vehicles/:vehicleId', () => {
    it('archives idle vehicle successfully', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        rental_status: 'IDLE',
        is_archived: false,
        registration_number: 'MP 04 AB 1111',
      });
      jest.spyOn(vehicleRepository, 'archiveVehicle').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        is_archived: true,
      });

      const res = await request(app)
        .delete(`/api/v1/partner/vehicles/${vehicle1Id}`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(res.body.data.message).toBe('Vehicle successfully archived');
    });

    it('rejects archiving with 409 if vehicle is BOOKED or ACTIVE', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        rental_status: 'ACTIVE',
        is_archived: false,
      });

      const res = await request(app)
        .delete(`/api/v1/partner/vehicles/${vehicle1Id}`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(409);
      expect(res.body.error.message).toContain('active trip is in progress');
    });
  });

  // ── 7. Images & Documents Management ────────────────────────────────
  describe('Images & Documents endpoints', () => {
    it('sets cover image successfully', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({ id: vehicle1Id, partner_id: partner1Id });
      jest.spyOn(vehicleRepository, 'findVehicleImageById').mockResolvedValue({ id: imageId, vehicle_id: vehicle1Id });
      jest.spyOn(vehicleRepository, 'setCoverImage').mockResolvedValue({
        id: imageId,
        vehicle_id: vehicle1Id,
        storage_key: 'img.jpg',
        is_cover: true,
      });

      const res = await request(app)
        .patch(`/api/v1/partner/vehicles/${vehicle1Id}/images/${imageId}/cover`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(res.body.data.isCover).toBe(true);
    });

    it('deletes vehicle image and triggers S3 deletion', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({ id: vehicle1Id, partner_id: partner1Id });
      jest.spyOn(vehicleRepository, 'findVehicleImageById').mockResolvedValue({
        id: imageId,
        vehicle_id: vehicle1Id,
        storage_key: 'partners/img.jpg',
      });
      jest.spyOn(vehicleRepository, 'deleteVehicleImage').mockResolvedValue({});
      const s3Spy = jest.spyOn(s3Provider, 'deleteObject').mockResolvedValue({});

      const res = await request(app)
        .delete(`/api/v1/partner/vehicles/${vehicle1Id}/images/${imageId}`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(res.body.data.message).toBe('Image successfully deleted');
      expect(s3Spy).toHaveBeenCalledWith({ key: 'partners/img.jpg' });
    });

    it('deletes vehicle document and triggers S3 deletion', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({ id: vehicle1Id, partner_id: partner1Id });
      jest.spyOn(vehicleRepository, 'findVehicleDocumentById').mockResolvedValue({
        id: docId,
        vehicle_id: vehicle1Id,
        document_type: 'Insurance',
        storage_key: 'partners/insurance.pdf',
      });
      jest.spyOn(vehicleRepository, 'deleteVehicleDocument').mockResolvedValue({});
      const s3Spy = jest.spyOn(s3Provider, 'deleteObject').mockResolvedValue({});

      const res = await request(app)
        .delete(`/api/v1/partner/vehicles/${vehicle1Id}/documents/${docId}`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(res.body.data.message).toBe('Document successfully deleted');
      expect(s3Spy).toHaveBeenCalledWith({ key: 'partners/insurance.pdf' });
    });

    it('enforces strict BOLA on image deletion for other partner vehicle', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue(null);

      const res = await request(app)
        .delete(`/api/v1/partner/vehicles/${vehicle2Id}/images/${imageId}`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(404);
    });
  });
});
