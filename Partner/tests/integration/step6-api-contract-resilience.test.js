'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const vehicleRepository = require('../../src/repositories/vehicle.repository');
const vehicleService = require('../../src/services/vehicle.service');
const bookingRepository = require('../../src/repositories/booking.repository');
const walletService = require('../../src/services/wallet.service');
const earningsService = require('../../src/services/earnings.service');
const pool = require('../../src/db/pool');
const consentRepository = require('../../src/repositories/consent.repository');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Step 6 Integration: API Contract, Error Handling & Production Resilience', () => {
  let app;
  let mockAuth;

  const partner1Id = '11111111-1111-4111-a111-111111111111';
  const partner2Id = '22222222-2222-4222-a222-222222222222';
  const vehicle1Id = 'aaaa1111-1111-4111-a111-111111111111';
  const vehicle2Id = 'bbbb2222-2222-4222-a222-222222222222';
  const booking1Id = 'cccc1111-1111-4111-a111-111111111111';

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();

    mockAuth = {
      verifyIdToken: jest.fn(async (token) => {
        if (token === 'valid-partner-token') {
          return { uid: 'uid-partner-1', phone_number: '+919876543210' };
        }
        if (token === 'attacker-partner-token') {
          return { uid: 'uid-partner-2', phone_number: '+919876543211' };
        }
        const err = new Error('Token expired or invalid');
        err.code = 'auth/id-token-expired';
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

  // 1. Vehicle Creation Contract & Validation
  describe('1. Vehicle Creation Contract & Validation', () => {
    it('rejects vehicle creation missing mandatory fields with 400 and VALIDATION_ERROR code', async () => {
      const res = await request(app)
        .post('/api/v1/partner/vehicles')
        .set('Authorization', 'Bearer valid-partner-token')
        .send({
          brand: 'Hyundai',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toHaveProperty('code');
      expect(res.body.error).toHaveProperty('message');
    });

    it('returns 201 with authoritative vehicle record on valid creation', async () => {
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
        brand: 'Hyundai',
        model: 'Creta',
        variant: 'SX',
        registration_number: 'KA01AB1234',
        year: 2023,
        fuel_type: 'Petrol',
        transmission: 'Manual',
        seats: 5,
        manual_status: 'ONLINE',
        rental_status: 'IDLE',
        verification_status: 'VERIFIED',
        is_archived: false,
        created_at: new Date().toISOString(),
      });

      const res = await request(app)
        .post('/api/v1/partner/vehicles')
        .set('Authorization', 'Bearer valid-partner-token')
        .send({
          category: 'Car',
          brand: 'Hyundai',
          model: 'Creta',
          variant: 'SX',
          registrationNumber: 'KA01AB1234',
          year: 2023,
          fuelType: 'Petrol',
          transmission: 'Manual',
          seats: 5,
          leaseAgreementAccepted: true,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('id', vehicle1Id);
      expect(res.body.data.brand).toBe('Hyundai');
      expect(recordConsentSpy).toHaveBeenCalledWith(expect.objectContaining({ vehicleId: vehicle1Id }));
    });
  });

  // 2. Vehicle Verification Authority & Online Gate
  describe('2. Vehicle Verification Authority & Online Gate', () => {
    it('allows bringing PENDING vehicle ONLINE while admin verification is pending', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        brand: 'Hyundai',
        model: 'Creta',
        verification_status: 'PENDING',
        manual_status: 'OFFLINE',
        rental_status: 'IDLE',
      });
      jest.spyOn(vehicleRepository, 'updateStatus').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        brand: 'Hyundai',
        model: 'Creta',
        verification_status: 'PENDING',
        manual_status: 'ONLINE',
        rental_status: 'IDLE',
      });

      const res = await request(app)
        .patch(`/api/v1/partner/vehicles/${vehicle1Id}/status`)
        .set('Authorization', 'Bearer valid-partner-token')
        .send({ status: 'ONLINE' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('strictly forbids bringing REJECTED vehicle ONLINE', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        brand: 'Hyundai',
        model: 'Creta',
        verification_status: 'REJECTED',
        manual_status: 'OFFLINE',
        rental_status: 'IDLE',
      });

      const res = await request(app)
        .patch(`/api/v1/partner/vehicles/${vehicle1Id}/status`)
        .set('Authorization', 'Bearer valid-partner-token')
        .send({ status: 'ONLINE' });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toMatch(/rejected/i);
    });

    it('allows bringing VERIFIED vehicle ONLINE', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        brand: 'Hyundai',
        model: 'Creta',
        verification_status: 'VERIFIED',
        manual_status: 'OFFLINE',
        rental_status: 'IDLE',
      });

      jest.spyOn(vehicleRepository, 'updateStatus').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        verification_status: 'VERIFIED',
        manual_status: 'ONLINE',
        rental_status: 'IDLE',
      });

      const res = await request(app)
        .patch(`/api/v1/partner/vehicles/${vehicle1Id}/status`)
        .set('Authorization', 'Bearer valid-partner-token')
        .send({ status: 'ONLINE' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.manualStatus).toBe('ONLINE');
    });
  });

  // 3. Vehicle Document Upload & Authority
  describe('3. Vehicle Document Upload & Authority Hardening', () => {
    it('disallows partner from overwriting verification_status to VERIFIED during submission (rejects mass assignment with 400)', async () => {
      const res = await request(app)
        .post('/api/v1/partner/vehicle-documents')
        .set('Authorization', 'Bearer valid-partner-token')
        .send({
          vehicleId: vehicle1Id,
          documentType: 'RC',
          storageKey: `partners/${partner1Id}/vehicles/${vehicle1Id}/documents/rc/rc.pdf`,
          documentNumber: 'DL01AB1234',
          verification_status: 'VERIFIED', // Partner attempt to forge verification
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
    });

    it('rejects partner attempting to upload document for vehicle owned by another partner (BOLA)', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue(null);

      const res = await request(app)
        .post('/api/v1/partner/vehicle-documents')
        .set('Authorization', 'Bearer attacker-partner-token')
        .send({
          vehicleId: vehicle1Id,
          documentType: 'RC',
          storageKey: `partners/${partner2Id}/vehicles/${vehicle1Id}/documents/rc/rc.pdf`,
          documentNumber: 'DL01AB1234',
        });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  // 4. Booking Mutation Contract & BOLA Security
  describe('4. Booking Mutation Contract & BOLA', () => {
    it('returns 404 when partner requests pickup OTP for a booking that does not belong to them', async () => {
      jest.spyOn(bookingRepository, 'findBookingByIdAndPartnerId').mockResolvedValue(null);

      const res = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/pickup/otp`)
        .set('Authorization', 'Bearer attacker-partner-token');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.NOT_FOUND);
    });

    it('rejects pickup verify if OTP is missing with 400', async () => {
      const res = await request(app)
        .post(`/api/v1/partner/bookings/${booking1Id}/pickup/verify`)
        .set('Authorization', 'Bearer valid-partner-token')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  // 5. Wallet Ledger & Earnings Contracts
  describe('5. Wallet Ledger & Earnings Contract', () => {
    it('returns authoritative wallet summary with numeric balance fields', async () => {
      jest.spyOn(walletService.walletRepository, 'findByPartnerId').mockResolvedValue({
        id: 'wal-01',
        partner_id: partner1Id,
        available_balance: '15420.50',
        pending_balance: '1200.00',
        total_credited: '16620.50',
        total_debited: '0.00',
        currency: 'INR',
        updated_at: '2026-09-22T10:00:00.000Z',
      });

      const res = await request(app)
        .get('/api/v1/partner/wallet')
        .set('Authorization', 'Bearer valid-partner-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('availableBalance', 15420.50);
      expect(res.body.data).toHaveProperty('pendingBalance', 1200.00);
    });

    it('returns earnings summary with consistent schema', async () => {
      jest.spyOn(earningsService, 'getEarningsSummary').mockResolvedValue({
        totalGrossEarnings: 45000,
        netPayouts: 38000,
        pendingSettlement: 7000,
        totalBookings: 24,
      });

      const res = await request(app)
        .get('/api/v1/partner/earnings/summary')
        .set('Authorization', 'Bearer valid-partner-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('totalGrossEarnings');
    });
  });

  // 6. Auth Expiration & Invalid Token Handling
  describe('6. Auth Expiration & Invalid Token Handling', () => {
    it('returns 401 with AUTH_EXPIRED / AUTH_INVALID error shape on expired token', async () => {
      const res = await request(app)
        .get('/api/v1/partner/profile')
        .set('Authorization', 'Bearer expired-or-corrupted-token');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toHaveProperty('code');
      expect(res.body.error).toHaveProperty('message');
    });

    it('returns 401 when Authorization header is completely omitted', async () => {
      const res = await request(app).get('/api/v1/partner/profile');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTH_REQUIRED);
    });
  });
});
