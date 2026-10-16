'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const PartnerRepository = require('../../src/repositories/partner.repository');
const RatingRepository = require('../../src/repositories/rating.repository');
const vehicleRepository = require('../../src/repositories/vehicle.repository');
const ratingService = require('../../src/services/rating.service');
const { redisClient } = require('../../src/providers/redis');
const { NotFoundError, BadRequestError, ConflictError } = require('../../src/errors');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Integration: Partner Rating System Foundation & Customer Compatibility', () => {
  let app;

  const partner1Id = '11111111-2222-3333-4444-555555555555';
  const partner1AuthId = 'auth-partner-1';
  const partner1Token = 'token-partner-1';

  const partner2Id = '99999999-8888-7777-6666-555555555555';
  const partner2AuthId = 'auth-partner-2';
  const partner2Token = 'token-partner-2';

  const newPartnerId = '00000000-1111-2222-3333-444444444444';
  const newPartnerAuthId = 'auth-new-partner';
  const newPartnerToken = 'token-new-partner';

  const vehicle1Id = 'aaaa1111-bbbb-2222-cccc-333333333333';
  const vehicle2Id = 'bbbb2222-cccc-3333-dddd-444444444444';
  const partner2VehicleId = 'cccc3333-dddd-4444-eeee-555555555555';

  const mockReviewsPartner1 = [
    {
      id: 'rat-001',
      bookingId: 'bk-101',
      bookingNumber: 'BK-101',
      targetType: 'PARTNER',
      ratingScore: 5,
      rating: 5,
      reviewComment: 'Outstanding service and quick vehicle handover!',
      comment: 'Outstanding service and quick vehicle handover!',
      createdAt: '2026-10-08T10:00:00.000Z',
      bookingDate: '2026-10-05T08:00:00.000Z',
      customerName: 'Aarav S.',
      vehicle: {
        id: vehicle1Id,
        brand: 'Mahindra',
        model: 'Thar',
        registrationNumber: 'KA-01-TH-1111',
      },
    },
    {
      id: 'rat-002',
      bookingId: 'bk-102',
      bookingNumber: 'BK-102',
      targetType: 'PARTNER',
      ratingScore: 4,
      rating: 4,
      reviewComment: 'Good experience, neat vehicle.',
      comment: 'Good experience, neat vehicle.',
      createdAt: '2026-10-07T12:00:00.000Z',
      bookingDate: '2026-10-04T09:00:00.000Z',
      customerName: 'Pooja V.',
      vehicle: {
        id: vehicle1Id,
        brand: 'Mahindra',
        model: 'Thar',
        registrationNumber: 'KA-01-TH-1111',
      },
    },
    {
      id: 'rat-003',
      bookingId: 'bk-103',
      bookingNumber: 'BK-103',
      targetType: 'PARTNER',
      ratingScore: 5,
      rating: 5,
      reviewComment: 'Excellent responsiveness!',
      comment: 'Excellent responsiveness!',
      createdAt: '2026-10-06T15:00:00.000Z',
      bookingDate: '2026-10-03T10:00:00.000Z',
      customerName: 'Vikram M.',
      vehicle: {
        id: vehicle2Id,
        brand: 'Hyundai',
        model: 'Creta',
        registrationNumber: 'KA-01-CR-2222',
      },
    },
  ];

  beforeAll(async () => {
    app = createApp();

    // Setup active sessions in Redis
    await redisClient.set(
      `auth:session:${partner1Token}`,
      JSON.stringify({
        uid: partner1AuthId,
        userId: 'usr-p1',
        phone: '9876543210',
        role: 'PARTNER',
        partnerId: partner1Id,
        createdAt: new Date().toISOString(),
      }),
      'EX',
      3600
    );

    await redisClient.set(
      `auth:session:${partner2Token}`,
      JSON.stringify({
        uid: partner2AuthId,
        userId: 'usr-p2',
        phone: '9876543211',
        role: 'PARTNER',
        partnerId: partner2Id,
        createdAt: new Date().toISOString(),
      }),
      'EX',
      3600
    );

    await redisClient.set(
      `auth:session:${newPartnerToken}`,
      JSON.stringify({
        uid: newPartnerAuthId,
        userId: 'usr-new-p',
        phone: '9876543212',
        role: 'PARTNER',
        partnerId: newPartnerId,
        createdAt: new Date().toISOString(),
      }),
      'EX',
      3600
    );

    // Mock partner identity lookup
    PartnerRepository.setMockPartnerResolver((idOrAuth) => {
      if (idOrAuth === partner1AuthId || idOrAuth === partner1Id) {
        return {
          id: partner1Id,
          partnerId: partner1Id,
          userId: 'usr-p1',
          auth_id: partner1AuthId,
          name: 'Apex Fleet Hub',
          phone: '+91 9876543210',
          role: 'PARTNER',
          is_active: true,
          partner_status: 'ONLINE',
          kyc_status: 'VERIFIED',
        };
      }
      if (idOrAuth === partner2AuthId || idOrAuth === partner2Id) {
        return {
          id: partner2Id,
          partnerId: partner2Id,
          userId: 'usr-p2',
          auth_id: partner2AuthId,
          name: 'City Rentals',
          phone: '+91 9876543211',
          role: 'PARTNER',
          is_active: true,
          partner_status: 'ONLINE',
          kyc_status: 'VERIFIED',
        };
      }
      if (idOrAuth === newPartnerAuthId || idOrAuth === newPartnerId) {
        return {
          id: newPartnerId,
          partnerId: newPartnerId,
          userId: 'usr-new-p',
          auth_id: newPartnerAuthId,
          name: 'Brand New Partner',
          phone: '+91 8888888888',
          role: 'PARTNER',
          is_active: true,
          partner_status: 'ONLINE',
          kyc_status: 'VERIFIED',
        };
      }
      return null;
    });
  });

  afterAll(async () => {
    PartnerRepository.setMockPartnerResolver(null);
    await redisClient.del(`auth:session:${partner1Token}`);
    await redisClient.del(`auth:session:${partner2Token}`);
    await redisClient.del(`auth:session:${newPartnerToken}`);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── 1. New Partner with Zero Ratings ───────────────────────────────────────
  describe('1. New Partner with Zero Ratings', () => {
    it('returns null averageRating, 0 totalReviews, and isNewPartner: true on summary endpoint', async () => {
      jest.spyOn(RatingRepository.prototype, 'getPartnerSummary').mockResolvedValue({
        averageRating: null,
        totalReviews: 0,
        distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        isNewPartner: true,
      });

      const res = await request(app)
        .get('/api/v1/partner/ratings/summary')
        .set('Authorization', `Bearer ${newPartnerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.averageRating).toBeNull();
      expect(res.body.data.totalReviews).toBe(0);
      expect(res.body.data.isNewPartner).toBe(true);
      expect(res.body.data.distribution).toEqual({
        1: 0, 2: 0, 3: 0, 4: 0, 5: 0,
      });
    });

    it('returns rating: null and reviewCount: 0 on profile endpoint without fabricating default numbers', async () => {
      jest.spyOn(RatingRepository.prototype, 'getPartnerSummary').mockResolvedValue({
        averageRating: null,
        totalReviews: 0,
        distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        isNewPartner: true,
      });

      const res = await request(app)
        .get('/api/v1/partner/profile')
        .set('Authorization', `Bearer ${newPartnerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.partner.rating).toBeNull();
      expect(res.body.data.partner.reviewCount).toBe(0);
      expect(res.body.data.partner.isNewPartner).toBe(true);
    });

    it('returns empty list for unrated partner reviews history', async () => {
      jest.spyOn(RatingRepository.prototype, 'getPartnerReviews').mockResolvedValue({
        ratings: [],
        pagination: {
          page: 1,
          limit: 10,
          total: 0,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      });

      const res = await request(app)
        .get('/api/v1/partner/ratings')
        .set('Authorization', `Bearer ${newPartnerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.ratings).toEqual([]);
      expect(res.body.data.pagination.total).toBe(0);
    });
  });

  // ── 2. Multiple Eligible Ratings & Aggregates ──────────────────────────────
  describe('2. Multiple Eligible Ratings Calculation & Star Distribution', () => {
    it('calculates authoritative partner average rating and 1-5 distribution', async () => {
      jest.spyOn(RatingRepository.prototype, 'getPartnerSummary').mockResolvedValue({
        averageRating: 4.7,
        totalReviews: 3,
        distribution: {
          5: 2,
          4: 1,
          3: 0,
          2: 0,
          1: 0,
        },
        isNewPartner: false,
      });

      const res = await request(app)
        .get('/api/v1/partner/ratings/summary')
        .set('Authorization', `Bearer ${partner1Token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const { averageRating, totalReviews, distribution, isNewPartner } = res.body.data;
      expect(averageRating).toBe(4.7);
      expect(totalReviews).toBe(3);
      expect(isNewPartner).toBe(false);
      expect(distribution).toEqual({
        5: 2,
        4: 1,
        3: 0,
        2: 0,
        1: 0,
      });
    });

    it('reflects updated rating and review count on GET /api/v1/partner/profile', async () => {
      jest.spyOn(RatingRepository.prototype, 'getPartnerSummary').mockResolvedValue({
        averageRating: 4.7,
        totalReviews: 3,
        distribution: { 5: 2, 4: 1, 3: 0, 2: 0, 1: 0 },
        isNewPartner: false,
      });

      const res = await request(app)
        .get('/api/v1/partner/profile')
        .set('Authorization', `Bearer ${partner1Token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.partner.rating).toBe(4.7);
      expect(res.body.data.partner.reviewCount).toBe(3);
    });
  });

  // ── 3. Vehicle-Wise Rating Aggregates ─────────────────────────────────────
  describe('3. Vehicle-Wise Aggregates & Overviews', () => {
    it('returns vehicle-specific rating average and count via /ratings/vehicles/:vehicleId', async () => {
      jest.spyOn(RatingRepository.prototype, 'getVehicleSummary').mockResolvedValue({
        vehicleId: vehicle1Id,
        brand: 'Mahindra',
        model: 'Thar',
        registrationNumber: 'KA-01-TH-1111',
        averageRating: 4.5,
        totalReviews: 2,
        distribution: { 5: 1, 4: 1, 3: 0, 2: 0, 1: 0 },
        hasRatings: true,
      });

      const res = await request(app)
        .get(`/api/v1/partner/ratings/vehicles/${vehicle1Id}`)
        .set('Authorization', `Bearer ${partner1Token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.averageRating).toBe(4.5);
      expect(res.body.data.totalReviews).toBe(2);
      expect(res.body.data.hasRatings).toBe(true);
      expect(res.body.data.distribution).toEqual({
        5: 1, 4: 1, 3: 0, 2: 0, 1: 0,
      });
    });

    it('returns vehicle-specific rating summary via GET /vehicles/:vehicleId/ratings', async () => {
      jest.spyOn(RatingRepository.prototype, 'getVehicleSummary').mockResolvedValue({
        vehicleId: vehicle1Id,
        brand: 'Mahindra',
        model: 'Thar',
        registrationNumber: 'KA-01-TH-1111',
        averageRating: 4.5,
        totalReviews: 2,
        distribution: { 5: 1, 4: 1, 3: 0, 2: 0, 1: 0 },
        hasRatings: true,
      });

      const res = await request(app)
        .get(`/api/v1/partner/vehicles/${vehicle1Id}/ratings`)
        .set('Authorization', `Bearer ${partner1Token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.averageRating).toBe(4.5);
    });

    it('returns vehicle overview list showing each vehicle rating across inventory', async () => {
      jest.spyOn(RatingRepository.prototype, 'getVehicleRatingsOverview').mockResolvedValue([
        {
          vehicleId: vehicle1Id,
          brand: 'Mahindra',
          model: 'Thar',
          registrationNumber: 'KA-01-TH-1111',
          averageRating: 4.5,
          totalReviews: 2,
          hasRatings: true,
        },
        {
          vehicleId: vehicle2Id,
          brand: 'Hyundai',
          model: 'Creta',
          registrationNumber: 'KA-01-CR-2222',
          averageRating: null,
          totalReviews: 0,
          hasRatings: false,
        },
      ]);

      const res = await request(app)
        .get('/api/v1/partner/ratings/vehicles')
        .set('Authorization', `Bearer ${partner1Token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.vehicles)).toBe(true);
      expect(res.body.data.vehicles.length).toBe(2);

      const v1 = res.body.data.vehicles[0];
      expect(v1.averageRating).toBe(4.5);
      expect(v1.totalReviews).toBe(2);

      const v2 = res.body.data.vehicles[1];
      expect(v2.averageRating).toBeNull();
      expect(v2.totalReviews).toBe(0);
      expect(v2.hasRatings).toBe(false);
    });

    it('returns ratingAvg and ratingCount in GET /api/v1/partner/vehicles/:id', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        category: 'Car',
        brand: 'Mahindra',
        model: 'Thar',
        registration_number: 'KA-01-TH-1111',
        rating_avg: '4.5',
        rating_count: 2,
        price_per_day: '2400.00',
        price_per_hour: '180.00',
        pricing_active: true,
      });
      jest.spyOn(vehicleRepository, 'getVehicleImages').mockResolvedValue([]);
      jest.spyOn(vehicleRepository, 'getVehicleDocuments').mockResolvedValue([]);

      const res = await request(app)
        .get(`/api/v1/partner/vehicles/${vehicle1Id}`)
        .set('Authorization', `Bearer ${partner1Token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.ratingAvg).toBe(4.5);
      expect(res.body.data.ratingCount).toBe(2);
      expect(res.body.data.averageRating).toBe(4.5);
      expect(res.body.data.reviewCount).toBe(2);
    });
  });

  // ── 4. Pagination & Filtering ─────────────────────────────────────────────
  describe('4. Pagination & Query Filtering', () => {
    it('supports pagination with page and limit parameters', async () => {
      jest.spyOn(RatingRepository.prototype, 'getPartnerReviews').mockResolvedValue({
        ratings: mockReviewsPartner1.slice(0, 2),
        pagination: {
          page: 1,
          limit: 2,
          total: 3,
          totalPages: 2,
          hasNext: true,
          hasPrev: false,
        },
      });

      const res = await request(app)
        .get('/api/v1/partner/ratings?page=1&limit=2')
        .set('Authorization', `Bearer ${partner1Token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.ratings.length).toBe(2);
      expect(res.body.data.pagination.page).toBe(1);
      expect(res.body.data.pagination.limit).toBe(2);
      expect(res.body.data.pagination.total).toBe(3);
      expect(res.body.data.pagination.hasNext).toBe(true);
    });

    it('filters ratings by star score (e.g. score=4)', async () => {
      jest.spyOn(RatingRepository.prototype, 'getPartnerReviews').mockResolvedValue({
        ratings: [mockReviewsPartner1[1]],
        pagination: {
          page: 1,
          limit: 10,
          total: 1,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      });

      const res = await request(app)
        .get('/api/v1/partner/ratings?score=4')
        .set('Authorization', `Bearer ${partner1Token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.ratings.length).toBe(1);
      expect(res.body.data.ratings[0].ratingScore).toBe(4);
    });

    it('filters ratings by vehicleId', async () => {
      jest.spyOn(RatingRepository.prototype, 'getPartnerReviews').mockResolvedValue({
        ratings: [mockReviewsPartner1[2]],
        pagination: {
          page: 1,
          limit: 10,
          total: 1,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      });

      const res = await request(app)
        .get(`/api/v1/partner/ratings?vehicleId=${vehicle2Id}`)
        .set('Authorization', `Bearer ${partner1Token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.ratings[0].vehicle.id).toBe(vehicle2Id);
    });
  });

  // ── 5. Security & Customer PII Masking ────────────────────────────────────
  describe('5. Customer PII Masking & Privacy', () => {
    it('masks customer full name and does NOT expose phone or sensitive customer information in review history', async () => {
      jest.spyOn(RatingRepository.prototype, 'getPartnerReviews').mockResolvedValue({
        ratings: mockReviewsPartner1,
        pagination: {
          page: 1,
          limit: 10,
          total: 3,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      });

      const res = await request(app)
        .get('/api/v1/partner/ratings')
        .set('Authorization', `Bearer ${partner1Token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const firstReview = res.body.data.ratings[0];
      expect(firstReview).toBeDefined();

      // Masked name: "Aarav S."
      expect(firstReview.customerName).toMatch(/^[A-Za-z]+ [A-Z]\.$|^Verified Customer$/);

      // Sensitive fields must NOT exist
      expect(firstReview.customerPhone).toBeUndefined();
      expect(firstReview.phone).toBeUndefined();
      expect(firstReview.email).toBeUndefined();
      expect(firstReview.customerId).toBeUndefined();
    });

    it('maskCustomerName utility masks two-word, single-word and null names safely', () => {
      expect(RatingRepository.maskCustomerName('Vikram Malhotra')).toBe('Vikram M.');
      expect(RatingRepository.maskCustomerName('Aarav')).toBe('Aarav');
      expect(RatingRepository.maskCustomerName('Dr. Sanjeev Kapoor')).toBe('Dr. K.');
      expect(RatingRepository.maskCustomerName('')).toBe('Verified Customer');
      expect(RatingRepository.maskCustomerName(null)).toBe('Verified Customer');
    });
  });

  // ── 6. Duplicate Protection & Business Invariant Validation ──────────────
  describe('6. Duplicate Prevention & Completed Booking Invariants', () => {
    it('rejects duplicate rating for the same booking and target_type with ConflictError', async () => {
      jest.spyOn(RatingRepository.prototype, 'createRating').mockImplementation(async (params) => {
        if (params.targetType === 'PARTNER' && params.bookingId === 'bk-dup') {
          throw new ConflictError('A partner rating has already been submitted for this booking', ERROR_CODES.CONFLICT);
        }
        return {};
      });

      await expect(
        ratingService.submitRating({
          bookingId: 'bk-dup',
          customerId: 'cust-1',
          partnerId: partner1Id,
          targetType: 'PARTNER',
          ratingScore: 4,
        })
      ).rejects.toThrow(/already been submitted/i);
    });

    it('rejects rating submission for non-completed (ACTIVE) booking with BadRequestError', async () => {
      jest.spyOn(RatingRepository.prototype, 'createRating').mockImplementation(async () => {
        throw new BadRequestError('Only completed bookings are eligible for rating', ERROR_CODES.INVALID_STATE);
      });

      await expect(
        ratingService.submitRating({
          bookingId: 'bk-active',
          customerId: 'cust-2',
          partnerId: partner1Id,
          targetType: 'PARTNER',
          ratingScore: 5,
        })
      ).rejects.toThrow(/Only completed bookings are eligible/i);
    });

    it('rejects ratings with invalid score out of bounds (< 1 or > 5)', async () => {
      jest.spyOn(RatingRepository.prototype, 'createRating').mockImplementation(async () => {
        throw new BadRequestError('Rating score must be an integer between 1 and 5', ERROR_CODES.VALIDATION_ERROR);
      });

      await expect(
        ratingService.submitRating({
          bookingId: 'bk-101',
          customerId: 'cust-1',
          partnerId: partner1Id,
          targetType: 'VEHICLE',
          ratingScore: 6,
        })
      ).rejects.toThrow(/between 1 and 5/i);
    });
  });

  // ── 7. Cross-Partner Isolation (BOLA) & Mutation Rejection ────────────────
  describe('7. Cross-Partner Isolation & Mutation Protection', () => {
    it('prevents Partner 1 from querying vehicle ratings of Partner 2 (BOLA 404)', async () => {
      jest.spyOn(RatingRepository.prototype, 'getVehicleSummary').mockImplementation(async (partnerId, vehicleId) => {
        if (partnerId === partner1Id && vehicleId === partner2VehicleId) {
          throw new NotFoundError('Vehicle not found or does not belong to partner', ERROR_CODES.NOT_FOUND);
        }
        return {};
      });

      const res = await request(app)
        .get(`/api/v1/partner/ratings/vehicles/${partner2VehicleId}`)
        .set('Authorization', `Bearer ${partner1Token}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('rejects attempts by Partners to create received ratings via POST with 403 Forbidden', async () => {
      const res = await request(app)
        .post('/api/v1/partner/ratings')
        .set('Authorization', `Bearer ${partner1Token}`)
        .send({ ratingScore: 5, reviewComment: 'Partner forged rating' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toMatch(/cannot create, alter or delete/i);
    });

    it('rejects attempts by Partners to modify ratings via PUT with 403 Forbidden', async () => {
      const res = await request(app)
        .put('/api/v1/partner/ratings/some-id')
        .set('Authorization', `Bearer ${partner1Token}`)
        .send({ ratingScore: 5 });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('rejects attempts by Partners to delete ratings via DELETE with 403 Forbidden', async () => {
      const res = await request(app)
        .delete('/api/v1/partner/ratings/some-id')
        .set('Authorization', `Bearer ${partner1Token}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('rejects unauthenticated requests to ratings endpoints with 401 Unauthorized', async () => {
      const res = await request(app).get('/api/v1/partner/ratings/summary');
      expect(res.status).toBe(401);
    });
  });
});
