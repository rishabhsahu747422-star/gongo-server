'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const authService = require('../../src/services/auth.service');
const vehicleService = require('../../src/services/vehicle.service');
const vehicleRepository = require('../../src/repositories/vehicle.repository');
const consentRepository = require('../../src/repositories/consent.repository');
const PartnerRepository = require('../../src/repositories/partner.repository');
const { DOCUMENT_TYPES, LEGAL_DOCUMENTS } = require('../../src/constants/legal.constants');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const pool = require('../../src/db/pool');

describe('Integration: Partner Consent Enforcement and Audit Trails', () => {
  const testPartnerId = '11111111-2222-3333-4444-555555555555';
  const testUserId = '66666666-7777-8888-9999-000000000000';
  let app;
  const devToken = 'dev-partner-token';

  beforeAll(() => {
    app = createApp();
  });

  afterAll(() => {
    PartnerRepository.setMockPartnerResolver(null);
    setMockFirebaseAuth(null);
  });

  beforeEach(() => {
    jest.clearAllMocks();

    setMockFirebaseAuth({
      verifyIdToken: async (token) => ({
        uid: 'uid-partner-1',
        phone_number: '+919876543210',
        email: 'test@gongo.in',
      }),
    });

    PartnerRepository.setMockPartnerResolver(() => ({
      id: testPartnerId,
      partnerId: testPartnerId,
      userId: testUserId,
      user_id: testUserId,
      name: 'Test Partner',
      role: 'PARTNER',
      partner_status: 'ONLINE',
      kyc_status: 'VERIFIED',
    }));
  });

  describe('GET /api/v1/auth/consents', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(app).get('/api/v1/auth/consents');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns live consent history for authenticated partner', async () => {
      const mockConsents = [
        {
          id: 'consent-1',
          document_type: DOCUMENT_TYPES.GONGO_TERMS,
          document_version: LEGAL_DOCUMENTS.GONGO_TERMS.version,
          content_hash: LEGAL_DOCUMENTS.GONGO_TERMS.contentHash,
          accepted_at: new Date('2026-10-13T10:00:00.000Z'),
          vehicle_id: null,
          metadata: { source: 'registration' },
        },
        {
          id: 'consent-2',
          document_type: DOCUMENT_TYPES.VEHICLE_LEASE_AGREEMENT,
          document_version: LEGAL_DOCUMENTS.VEHICLE_LEASE_AGREEMENT.version,
          content_hash: LEGAL_DOCUMENTS.VEHICLE_LEASE_AGREEMENT.contentHash,
          accepted_at: new Date('2026-10-13T11:00:00.000Z'),
          vehicle_id: 'veh-123',
          metadata: { source: 'add_vehicle' },
        },
      ];

      jest.spyOn(consentRepository, 'getLatestConsentsByPartnerId').mockResolvedValueOnce(mockConsents);

      const res = await request(app)
        .get('/api/v1/auth/consents')
        .set('Authorization', `Bearer ${devToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(2);
      expect(res.body.data[0].documentType).toBe(DOCUMENT_TYPES.GONGO_TERMS);
      expect(res.body.data[0].documentVersion).toBe('1.0.0');
      expect(res.body.data[1].documentType).toBe(DOCUMENT_TYPES.VEHICLE_LEASE_AGREEMENT);
    });
  });

  describe('Registration Terms & Conditions Enforcement', () => {
    it('blocks partner registration when termsAccepted is omitted or false', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .set('Authorization', `Bearer ${devToken}`)
        .send({
          name: 'Consent Partner',
          shopName: 'Consent Hub',
          city: 'Bhopal',
          landmark: 'City Center',
          phone: '9988776655',
          termsAccepted: false,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toMatch(/GONGO Terms & Conditions/i);
    });
  });

  describe('Vehicle Lease Agreement Enforcement', () => {
    it('blocks vehicle creation when leaseAgreementAccepted is omitted or false', async () => {
      const res = await request(app)
        .post('/api/v1/partner/vehicles')
        .set('Authorization', `Bearer ${devToken}`)
        .send({
          category: 'Car',
          brand: 'Hyundai',
          model: 'Creta',
          registrationNumber: 'MP 04 CC 9999',
          year: 2024,
          fuelType: 'Petrol',
          leaseAgreementAccepted: false,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toMatch(/Vehicle Lease Agreement/i);
    });

    it('records immutable lease consent in partner_consents upon successful vehicle creation', async () => {
      const recordConsentSpy = jest.spyOn(consentRepository, 'recordConsent').mockResolvedValueOnce({
        id: 'new-lease-consent-id',
      });
      jest.spyOn(vehicleRepository, 'findByRegistrationNumber').mockResolvedValueOnce(null);
      jest.spyOn(vehicleService.partnerRepository, 'findById').mockResolvedValueOnce({
        id: testPartnerId,
        user_id: testUserId,
      });
      jest.spyOn(pool, 'transaction').mockImplementationOnce(async (cb) => {
        return cb({});
      });
      jest.spyOn(vehicleRepository, 'createVehicle').mockResolvedValueOnce({
        id: 'new-veh-id',
        partner_id: testPartnerId,
        registration_number: 'MP 04 CC 9999',
        category: 'Car',
        brand: 'Hyundai',
        model: 'Creta',
        manual_status: 'ONLINE',
        rental_status: 'IDLE',
      });

      const res = await request(app)
        .post('/api/v1/partner/vehicles')
        .set('Authorization', `Bearer ${devToken}`)
        .send({
          category: 'Car',
          brand: 'Hyundai',
          model: 'Creta',
          registrationNumber: 'MP 04 CC 9999',
          year: 2024,
          fuelType: 'Petrol',
          leaseAgreementAccepted: true,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(recordConsentSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          documentType: DOCUMENT_TYPES.VEHICLE_LEASE_AGREEMENT,
          documentVersion: LEGAL_DOCUMENTS.VEHICLE_LEASE_AGREEMENT.version,
          contentHash: LEGAL_DOCUMENTS.VEHICLE_LEASE_AGREEMENT.contentHash,
          vehicleId: 'new-veh-id',
        })
      );
    });
  });
});
