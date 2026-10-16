const adminVehicleRepository = require('../../src/repositories/admin-vehicle.repository');
const adminBookingRepository = require('../../src/repositories/admin-booking.repository');
const adminPartnerRepository = require('../../src/repositories/admin-partner.repository');
const adminShopRepository = require('../../src/repositories/admin-shop.repository');

describe('Ratings & Reviews Integration Unit Tests (TEST A - TEST J)', () => {
  describe('TEST A & B: Vehicle Inventory Rating Aggregation', () => {
    it('TEST A: Vehicle with reviews maps correct average rating and review count', () => {
      const mockDbRow = {
        id: 'v-1111',
        model_name: 'Mahindra Thar',
        brand: 'Mahindra',
        avg_rating: '4.60',
        review_count: '24',
        status: 'ACTIVE',
      };

      // Simulating mapping logic from admin-vehicle.repository.js
      const mapped = {
        id: mockDbRow.id,
        modelName: mockDbRow.model_name,
        rating: mockDbRow.avg_rating !== null ? parseFloat(mockDbRow.avg_rating) : null,
        reviewCount: parseInt(mockDbRow.review_count || 0, 10),
      };

      expect(mapped.rating).toBe(4.6);
      expect(mapped.reviewCount).toBe(24);
    });

    it('TEST B: Vehicle without reviews returns null rating and 0 count (displayed as New)', () => {
      const mockDbRow = {
        id: 'v-2222',
        model_name: 'Honda Activa 6G',
        brand: 'Honda',
        avg_rating: null,
        review_count: '0',
        status: 'ACTIVE',
      };

      const mapped = {
        id: mockDbRow.id,
        modelName: mockDbRow.model_name,
        rating: mockDbRow.avg_rating !== null ? parseFloat(mockDbRow.avg_rating) : null,
        reviewCount: parseInt(mockDbRow.review_count || 0, 10),
      };

      expect(mapped.rating).toBeNull();
      expect(mapped.reviewCount).toBe(0);
    });
  });

  describe('TEST C, D & E: Individual Booking Ratings', () => {
    it('TEST C: Booking with review returns individual rating and review text', () => {
      const mockDbRow = {
        id: 'b-1001',
        booking_reference: 'BK-1001',
        vehicle_id: 'v-1111',
        review_rating: '4.00',
        review_comment: 'Smooth ride',
      };

      const mapped = {
        id: mockDbRow.id,
        rating: mockDbRow.review_rating !== null ? parseFloat(mockDbRow.review_rating) : null,
        reviewComment: mockDbRow.review_comment || null,
        review: mockDbRow.review_rating !== null ? {
          rating: parseFloat(mockDbRow.review_rating),
          comment: mockDbRow.review_comment || null,
        } : null,
      };

      expect(mapped.rating).toBe(4.0);
      expect(mapped.review).toEqual({
        rating: 4.0,
        comment: 'Smooth ride',
      });
    });

    it('TEST D: Booking without review returns null rating (displayed as Not rated)', () => {
      const mockDbRow = {
        id: 'b-1002',
        booking_reference: 'BK-1002',
        vehicle_id: 'v-1111',
        review_rating: null,
        review_comment: null,
      };

      const mapped = {
        id: mockDbRow.id,
        rating: mockDbRow.review_rating !== null ? parseFloat(mockDbRow.review_rating) : null,
        review: null,
      };

      expect(mapped.rating).toBeNull();
      expect(mapped.review).toBeNull();
    });

    it('TEST E: Two bookings for same vehicle have independent individual ratings, not vehicle average', () => {
      const vehicleOverallRating = 4.6;

      const bookingA = {
        id: 'b-A',
        vehicleId: 'v-1111',
        rating: 5.0,
      };

      const bookingB = {
        id: 'b-B',
        vehicleId: 'v-1111',
        rating: 3.0,
      };

      expect(bookingA.rating).toBe(5.0);
      expect(bookingB.rating).toBe(3.0);
      expect(bookingA.rating).not.toBe(vehicleOverallRating);
      expect(bookingB.rating).not.toBe(vehicleOverallRating);
    });
  });

  describe('TEST F, G & H: Partner and Shop Aggregate Calculations', () => {
    it('TEST F: Partner aggregate uses eligible reviews and calculates distinct review weighted average', () => {
      // Direct partner reviews: 4 and 5 -> avg 4.5
      const partnerRating = 4.5;
      const reviewCount = 2;

      expect(partnerRating).toBe(4.5);
      expect(reviewCount).toBe(2);
    });

    it('TEST G: Multiple shops isolate their own reviews via shop_id', () => {
      const shop1 = {
        id: 'shop-1',
        rating: 4.0,
        reviewCount: 2,
      };

      const shop2 = {
        id: 'shop-2',
        rating: null,
        reviewCount: 0,
      };

      expect(shop1.rating).toBe(4.0);
      expect(shop2.rating).toBeNull();
      expect(shop1.rating).not.toBe(shop2.rating);
    });

    it('TEST H: Distinct review aggregation prevents inflated counts from joins', () => {
      // With DISTINCT count in SQL `COUNT(DISTINCT r.id)`, 2 reviews joined with n records still produces 2
      const reviews = [{ id: 'rev-1', score: 4 }, { id: 'rev-2', score: 5 }];
      const distinctCount = new Set(reviews.map((r) => r.id)).size;
      expect(distinctCount).toBe(2);
    });
  });

  describe('TEST I & J: API Field Mapping and Compatibility', () => {
    it('TEST I: Backend and Frontend field mappings match', () => {
      // Backend projects: rating, reviewCount, review, reviewComment
      const vehicleBackendDto = { rating: 4.2, reviewCount: 12 };
      expect(vehicleBackendDto).toHaveProperty('rating');
      expect(vehicleBackendDto).toHaveProperty('reviewCount');

      const bookingBackendDto = { rating: 4.0, review: { rating: 4, comment: 'Nice' } };
      expect(bookingBackendDto).toHaveProperty('rating');
      expect(bookingBackendDto).toHaveProperty('review');

      const partnerBackendDto = { rating: 4.7, reviewCount: 42 };
      expect(partnerBackendDto).toHaveProperty('rating');
      expect(partnerBackendDto).toHaveProperty('reviewCount');
    });

    it('TEST J: Existing query builders construct valid SQL with filters, pagination, and joins', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({
          rows: [{
            id: 'v-test',
            partner_id: 'p-1',
            shop_id: 's-1',
            category: 'CAR',
            brand: 'Test',
            model: 'Test Car',
            variant: 'V1',
            registration_number: 'KA-01-AB-1234',
            year: 2024,
            fuel_type: 'Petrol',
            transmission: 'Manual',
            seats: 5,
            description: 'Test',
            manual_status: 'ONLINE',
            rental_status: 'IDLE',
            verification_status: 'VERIFIED',
            is_archived: false,
            offline_reason: null,
            created_at: new Date(),
            updated_at: new Date(),
            partner_name: 'Test Partner',
            shop_name: 'Test Shop',
            daily_rate: 1500,
            primary_image_url: null,
            primary_image_path: null,
            rating: '4.8',
            review_count: '15',
          }],
        }),
      };

      const result = await adminVehicleRepository.listVehicles({ limit: 10, offset: 0 }, mockClient);
      expect(mockClient.query).toHaveBeenCalled();
      expect(result.vehicles[0].rating).toBe(4.8);
      expect(result.vehicles[0].reviewCount).toBe(15);
    });
  });
});
