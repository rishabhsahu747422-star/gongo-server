'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const earningsService = require('../../src/services/earnings.service');

describe('Integration: Partner Earnings Visibility APIs (Phase 12C)', () => {
  let app;
  let mockAuth;

  const partner1Id = '11111111-1111-4111-a111-111111111111';
  const partner2Id = '22222222-2222-4222-a222-222222222222';
  const earning1Id = '33333333-3333-4333-a333-333333333333';

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

  afterAll(() => {
    PartnerRepository.setMockPartnerResolver(null);
  });

  describe('GET /api/v1/partner/earnings', () => {
    it('returns paginated earnings for the authenticated partner', async () => {
      jest.spyOn(earningsService, 'getEarnings').mockResolvedValue({
        items: [
          {
            id: earning1Id,
            partnerId: partner1Id,
            bookingId: 'book-1',
            bookingNumber: 'BK-1001',
            walletTransactionId: 'tx-1',
            grossAmount: 350.00,
            partnerNetAmount: 350.00,
            settlementStatus: 'SETTLED',
            settledAt: '2026-03-01T10:00:00.000Z',
            createdAt: '2026-03-01T10:00:00.000Z',
            updatedAt: '2026-03-01T10:00:00.000Z',
          },
        ],
        pagination: {
          page: 1,
          limit: 20,
          totalItems: 1,
          totalPages: 1,
          hasNextPage: false,
          hasPrevPage: false,
        },
      });

      const res = await request(app)
        .get('/api/v1/partner/earnings')
        .set('Authorization', 'Bearer partner-1-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].id).toBe(earning1Id);
      expect(res.body.data.items[0].grossAmount).toBe(350.00);
      expect(earningsService.getEarnings).toHaveBeenCalledWith(partner1Id, expect.any(Object));
    });

    it('rejects unauthenticated requests with 401', async () => {
      await request(app)
        .get('/api/v1/partner/earnings')
        .expect(401);
    });

    it('validates query parameters and rejects invalid limit with 400', async () => {
      const res = await request(app)
        .get('/api/v1/partner/earnings?limit=200')
        .set('Authorization', 'Bearer partner-1-token')
        .expect(400);

      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /api/v1/partner/earnings/summary', () => {
    it('returns aggregated earnings summary for the authenticated partner', async () => {
      jest.spyOn(earningsService, 'getEarningsSummary').mockResolvedValue({
        totalGrossEarnings: 1500.00,
        totalNetEarnings: 1500.00,
        totalSettled: 1200.00,
        totalPending: 300.00,
        totalRecords: 5,
        settledCount: 4,
        pendingCount: 1,
      });

      const res = await request(app)
        .get('/api/v1/partner/earnings/summary')
        .set('Authorization', 'Bearer partner-1-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.totalGrossEarnings).toBe(1500.00);
      expect(res.body.data.totalSettled).toBe(1200.00);
      expect(res.body.data.pendingCount).toBe(1);
      expect(earningsService.getEarningsSummary).toHaveBeenCalledWith(partner1Id);
    });
  });

  describe('GET /api/v1/partner/earnings/:earningId', () => {
    it('returns single earning details for owning partner', async () => {
      jest.spyOn(earningsService, 'getEarningById').mockResolvedValue({
        id: earning1Id,
        partnerId: partner1Id,
        bookingId: 'book-1',
        bookingNumber: 'BK-1001',
        walletTransactionId: 'tx-1',
        grossAmount: 350.00,
        partnerNetAmount: 350.00,
        settlementStatus: 'SETTLED',
        settledAt: '2026-03-01T10:00:00.000Z',
        createdAt: '2026-03-01T10:00:00.000Z',
        updatedAt: '2026-03-01T10:00:00.000Z',
      });

      const res = await request(app)
        .get(`/api/v1/partner/earnings/${earning1Id}`)
        .set('Authorization', 'Bearer partner-1-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(earning1Id);
      expect(res.body.data.grossAmount).toBe(350.00);
      expect(earningsService.getEarningById).toHaveBeenCalledWith(partner1Id, earning1Id);
    });

    it('rejects invalid UUID format with 400', async () => {
      const res = await request(app)
        .get('/api/v1/partner/earnings/not-a-uuid')
        .set('Authorization', 'Bearer partner-1-token')
        .expect(400);

      expect(res.body.success).toBe(false);
    });
  });
});
