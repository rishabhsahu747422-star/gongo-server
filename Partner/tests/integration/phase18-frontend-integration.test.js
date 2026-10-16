'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const UserRepository = require('../../src/repositories/user.repository');
const ShopRepository = require('../../src/repositories/shop.repository');
const BankAccountRepository = require('../../src/repositories/bank-account.repository');
const vehicleService = require('../../src/services/vehicle.service');
const bookingService = require('../../src/services/booking.service');
const notificationService = require('../../src/services/notification.service');
const kycService = require('../../src/services/kyc.service');
const storageService = require('../../src/services/storage.service');

describe('Integration: Phase 18 Partner Frontend Contract Integration', () => {
  let app;
  let mockAuth;

  const partner1Id = '11111111-1111-4111-a111-111111111111';
  const partner2Id = '22222222-2222-4222-a222-222222222222';
  const vehicleId = '33333333-3333-4333-a333-333333333333';
  const bookingId = '44444444-4444-4444-a444-444444444444';

  beforeAll(() => {
    app = createApp();
  });

  afterAll(() => {
    PartnerRepository.setMockPartnerResolver(null);
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
          name: 'Partner One',
          email: 'partner1@example.com',
          phone: '9876543210',
          role: 'PARTNER',
          kyc_status: 'VERIFIED',
          partner_status: 'ACTIVE',
          rating: '4.95',
          review_count: 42,
          is_active: true,
        };
      }
      if (idOrAuth === 'uid-partner-2' || idOrAuth === partner2Id) {
        return {
          id: partner2Id,
          partnerId: partner2Id,
          userId: 'user-partner-2',
          auth_id: 'uid-partner-2',
          name: 'Partner Two',
          email: 'partner2@example.com',
          phone: '9876543211',
          role: 'PARTNER',
          kyc_status: 'PENDING',
          partner_status: 'ACTIVE',
          rating: '5.00',
          review_count: 0,
          is_active: true,
        };
      }
      return null;
    });
  });

  // ── 1. Auth & Phone Format Normalization ────────────────────────────────
  describe('1. Auth Phone Format & Session Bootstrap', () => {
    it('accepts phoneNumber alias in check-phone and normalizes phone number', async () => {
      jest.spyOn(UserRepository.prototype, 'findByPhone').mockResolvedValueOnce({
        id: 'user-partner-1',
        phone: '9876543210',
        role: 'PARTNER',
        is_active: true,
      });

      const res = await request(app)
        .post('/api/v1/auth/check-phone')
        .send({ phoneNumber: '+91 9876543210' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isExisting).toBe(true);
      expect(res.body.data.phone).toBe('9876543210');
    });

    it('populates bankAccount and isNewPartner in POST /auth/session', async () => {
      jest.spyOn(ShopRepository.prototype, 'findByPartnerId').mockResolvedValueOnce({
        id: 'shop-1',
        shop_name: 'Metro Wheels',
        shop_address: 'Main Street',
        city: 'Indore',
      });
      jest.spyOn(BankAccountRepository.prototype, 'findPrimaryByPartnerId').mockResolvedValueOnce({
        id: 'bank-1',
        bank_name: 'HDFC Bank',
        account_holder_name: 'Partner One',
        account_number_masked: '•••• •••• 5678',
        ifscCode: 'HDFC0001234',
        is_primary: true,
        verification_status: 'VERIFIED',
      });
      jest.spyOn(PartnerRepository.prototype, 'countVehicles').mockResolvedValueOnce(3);

      const res = await request(app)
        .post('/api/v1/auth/session')
        .set('Authorization', 'Bearer partner-1-token')
        .send();

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.partner.bankAccount).toEqual(expect.objectContaining({
        id: 'bank-1',
        bankName: 'HDFC Bank',
        accountNumberMasked: '•••• •••• 5678',
      }));
      expect(res.body.data.partner.isNewPartner).toBe(false);
    });

    it('populates bankAccount in GET /auth/me and GET /partner/profile', async () => {
      jest.spyOn(ShopRepository.prototype, 'findByPartnerId').mockResolvedValue({
        id: 'shop-1',
        shop_name: 'Metro Wheels',
        shop_address: 'Main Street',
        city: 'Indore',
      });
      jest.spyOn(BankAccountRepository.prototype, 'findPrimaryByPartnerId').mockResolvedValue({
        id: 'bank-1',
        bank_name: 'HDFC Bank',
        account_holder_name: 'Partner One',
        account_number_masked: '•••• •••• 5678',
        ifsc_code: 'HDFC0001234',
        is_primary: true,
        verification_status: 'VERIFIED',
      });
      jest.spyOn(PartnerRepository.prototype, 'countVehicles').mockResolvedValue(0);

      const meRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer partner-1-token');

      expect(meRes.status).toBe(200);
      expect(meRes.body.data.partner.bankAccount).toEqual(expect.objectContaining({
        bankName: 'HDFC Bank',
      }));
      expect(meRes.body.data.partner.isNewPartner).toBe(true);

      const profRes = await request(app)
        .get('/api/v1/partner/profile')
        .set('Authorization', 'Bearer partner-1-token');

      expect(profRes.status).toBe(200);
      expect(profRes.body.data.partner.bankAccount).toBeDefined();
      expect(profRes.body.data.partner.isNewPartner).toBe(true);
    });
  });

  // ── 2. Vehicle Creation Wizard & Shape Compatibility ────────────────────
  describe('2. Vehicle Creation Wizard & Response Shape', () => {
    it('creates vehicle with type alias, EV normalization, and inline pricing', async () => {
      const mockCreated = {
        id: vehicleId,
        partnerId: partner1Id,
        category: 'Car',
        type: 'Car',
        brand: 'Tata',
        model: 'Nexon EV',
        registrationNumber: 'MP 09 CD 4567',
        fuelType: 'EV',
        transmission: 'Automatic',
        seats: 5,
        status: 'AVAILABLE',
        pricePerHour: 150,
        pricePer4Hours: 550,
        pricePerDay: 1800,
        securityDeposit: 3000,
        extraKmCharge: 12,
        totalEarnings: 0,
        totalBookings: 0,
        createdAt: new Date().toISOString(),
      };

      jest.spyOn(vehicleService, 'createVehicle').mockImplementationOnce(async ({ input }) => {
        expect(input.type).toBe('Car');
        expect(input.fuelType).toBe('Electric');
        expect(input.pricePerDay).toBe(1800);
        return mockCreated;
      });

      const res = await request(app)
        .post('/api/v1/partner/vehicles')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          type: 'Car',
          brand: 'Tata',
          model: 'Nexon EV',
          registrationNumber: 'MP 09 CD 4567',
          year: 2024,
          fuelType: 'Electric',
          transmission: 'Automatic',
          seats: 5,
          pricePerHour: 150,
          pricePer4Hours: 550,
          pricePerDay: 1800,
          securityDeposit: 3000,
          extraKmCharge: 12,
          images: ['s3://bucket/test.jpg'],
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.type).toBe('Car');
      expect(res.body.data.fuelType).toBe('EV');
      expect(res.body.data.pricePerHour).toBe(150);
      expect(res.body.data.pricePerDay).toBe(1800);
    });

    it('returns top-level pricing and status aliases on GET /partner/vehicles', async () => {
      jest.spyOn(vehicleService, 'getVehicles').mockResolvedValueOnce({
        vehicles: [
          {
            id: vehicleId,
            category: 'Bike',
            type: 'Bike',
            brand: 'Royal Enfield',
            model: 'Classic 350',
            pricePerHour: 50,
            pricePer4Hours: 180,
            pricePerDay: 600,
            securityDeposit: 1000,
            extraKmCharge: 5,
            status: 'AVAILABLE',
            totalEarnings: 4500,
            totalBookings: 8,
          },
        ],
        pagination: { total: 1, page: 1, limit: 20, totalPages: 1 },
      });

      const res = await request(app)
        .get('/api/v1/partner/vehicles')
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(res.body.data.vehicles[0].type).toBe('Bike');
      expect(res.body.data.vehicles[0].pricePerHour).toBe(50);
      expect(res.body.data.vehicles[0].totalEarnings).toBe(4500);
    });
  });

  // ── 3. Booking Shape & Pricing Aliases ──────────────────────────────────
  describe('3. Booking Hourly Rate & Rental Duration Aliases', () => {
    it('exposes hourlyRate and rentalDurationMinutes in booking response', async () => {
      jest.spyOn(bookingService, 'getBookingById').mockResolvedValueOnce({
        id: bookingId,
        bookingNumber: 'BK-2026-001',
        status: 'UPCOMING',
        bookingStatus: 'CONFIRMED',
        vehicleId,
        vehicleName: 'Tata Nexon EV',
        hourlyRate: 150,
        rentalDurationMinutes: 1440,
        bookingAmount: 1800,
        securityDeposit: 3000,
      });

      const res = await request(app)
        .get(`/api/v1/partner/bookings/${bookingId}`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(res.body.data.hourlyRate).toBe(150);
      expect(res.body.data.rentalDurationMinutes).toBe(1440);
      expect(res.body.data.status).toBe('UPCOMING');
    });
  });

  // ── 4. Notifications & Mark-All-Read Routes ─────────────────────────────
  describe('4. Notifications Aliases & Mark-All-Read Routes', () => {
    it('returns notifications with message and unread aliases', async () => {
      jest.spyOn(notificationService, 'getNotifications').mockResolvedValueOnce({
        items: [
          {
            id: 'notif-1',
            title: 'New Booking',
            body: 'You have a new booking BK-2026-001',
            message: 'You have a new booking BK-2026-001',
            unread: true,
            isRead: false,
            createdAt: new Date().toISOString(),
          },
        ],
        pagination: { page: 1, limit: 20, totalItems: 1, totalPages: 1 },
      });

      const res = await request(app)
        .get('/api/v1/partner/notifications')
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(res.body.data.items[0].message).toBe('You have a new booking BK-2026-001');
      expect(res.body.data.items[0].unread).toBe(true);
    });

    it('supports POST /read-all, POST /mark-all-read, and PATCH /mark-all-read', async () => {
      jest.spyOn(notificationService, 'markAllAsRead').mockResolvedValue({
        success: true,
        count: 5,
      });

      const resPost1 = await request(app)
        .post('/api/v1/partner/notifications/mark-all-read')
        .set('Authorization', 'Bearer partner-1-token')
        .send();
      expect(resPost1.status).toBe(200);

      const resPatch1 = await request(app)
        .patch('/api/v1/partner/notifications/mark-all-read')
        .set('Authorization', 'Bearer partner-1-token')
        .send();
      expect(resPatch1.status).toBe(200);

      const resPost2 = await request(app)
        .post('/api/v1/partner/notifications/read-all')
        .set('Authorization', 'Bearer partner-1-token')
        .send();
      expect(resPost2.status).toBe(200);
    });
  });

  // ── 5. KYC GSTIN Document Normalization ────────────────────────────────
  describe('5. KYC Document Normalization', () => {
    it('normalizes GSTIN to GST on KYC document submission', async () => {
      jest.spyOn(kycService, 'submitDocument').mockImplementationOnce(
        async (partnerId, data) => {
          expect(data.documentType).toBe('GST');
          return {
            id: 'doc-1',
            partnerId,
            documentType: data.documentType,
            documentNumber: data.documentNumber,
            verificationStatus: 'PENDING',
          };
        },
      );

      const res = await request(app)
        .post('/api/v1/partner/kyc/documents')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          documentType: 'GSTIN',
          documentNumber: '29ABCDE1234F1Z5',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.documentType).toBe('GST');
    });
  });

  // ── 6. Storage Presign for Support Attachment ───────────────────────────
  describe('6. Storage Presign Support Attachment', () => {
    it('generates presigned PUT URL for SUPPORT_ATTACHMENT', async () => {
      jest.spyOn(storageService, 'presignUpload').mockImplementationOnce(
        async ({ partnerId, input }) => {
          expect(partnerId).toBe(partner1Id);
          expect(input.entityType).toBe('SUPPORT_ATTACHMENT');
          expect(input.fileName).toBe('screenshot.png');
          expect(input.contentType).toBe('image/png');
          return {
            uploadId: 'up-1',
            storageKey: `partners/${partner1Id}/support/uuid.png`,
            uploadUrl: 'https://s3.amazonaws.com/test-bucket/upload',
            expiresAt: new Date().toISOString(),
          };
        },
      );

      const res = await request(app)
        .post('/api/v1/partner/storage/presign-upload')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          entityType: 'SUPPORT_ATTACHMENT',
          fileName: 'screenshot.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.storageKey).toContain('/support/');
    });
  });
});
