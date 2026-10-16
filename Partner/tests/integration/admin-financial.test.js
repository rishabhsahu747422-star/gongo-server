'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const adminFinancialService = require('../../src/services/admin-financial.service');

describe('Integration: Admin Financial & Payout Management APIs (Phase 13)', () => {
  let app;
  let mockAuth;

  const adminUserId = '99999999-9999-4999-a999-999999999999';
  const partnerUserId = '11111111-1111-4111-a111-111111111111';
  const payout1Id = '77777777-7777-4777-a777-777777777777';

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();

    mockAuth = {
      verifyIdToken: jest.fn(async (token) => {
        if (token === 'admin-token') {
          return { uid: 'uid-admin', phone_number: '+919999999999' };
        }
        if (token === 'partner-token') {
          return { uid: 'uid-partner', phone_number: '+919876543210' };
        }
        const err = new Error('Invalid token');
        err.code = 'auth/invalid-id-token';
        throw err;
      }),
      revokeRefreshTokens: jest.fn().mockResolvedValue(true),
    };
    setMockFirebaseAuth(mockAuth);

    PartnerRepository.setMockPartnerResolver((idOrAuth) => {
      if (idOrAuth === 'uid-admin' || idOrAuth === adminUserId) {
        return {
          id: adminUserId,
          userId: adminUserId,
          auth_id: 'uid-admin',
          role: 'ADMIN',
          is_active: true,
        };
      }
      if (idOrAuth === 'uid-partner' || idOrAuth === partnerUserId) {
        return {
          id: partnerUserId,
          partnerId: partnerUserId,
          userId: partnerUserId,
          auth_id: 'uid-partner',
          role: 'PARTNER',
          is_active: true,
        };
      }
      return null;
    });
  });

  afterAll(() => {
    PartnerRepository.setMockPartnerResolver(null);
  });

  describe('RBAC Authorization', () => {
    it('rejects partner role accessing admin financials with 403', async () => {
      await request(app)
        .get('/api/v1/admin/financials/settlements')
        .set('Authorization', 'Bearer partner-token')
        .expect(403);
    });

    it('rejects unauthenticated requests with 401', async () => {
      await request(app)
        .get('/api/v1/admin/financials/settlements')
        .expect(401);
    });
  });

  describe('Admin Financial Endpoints', () => {
    it('GET /api/v1/admin/financials/settlements returns settlements list', async () => {
      jest.spyOn(adminFinancialService, 'listSettlements').mockResolvedValue({
        items: [
          {
            id: 'earn-1',
            partnerId: partnerUserId,
            partnerName: 'Fleet Hub',
            grossAmount: 500.00,
            partnerNetAmount: 425.00,
            settlementStatus: 'SETTLED',
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
        .get('/api/v1/admin/financials/settlements')
        .set('Authorization', 'Bearer admin-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].partnerName).toBe('Fleet Hub');
    });

    it('GET /api/v1/admin/financials/commissions returns commission records', async () => {
      jest.spyOn(adminFinancialService, 'listCommissions').mockResolvedValue({
        items: [
          {
            id: 'comm-1',
            bookingNumber: 'BK-1001',
            commissionRate: 0.15,
            commissionAmount: 75.00,
            status: 'CALCULATED',
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
        .get('/api/v1/admin/financials/commissions')
        .set('Authorization', 'Bearer admin-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.items[0].commissionAmount).toBe(75.00);
    });

    it('GET /api/v1/admin/financials/summary returns platform metrics', async () => {
      jest.spyOn(adminFinancialService, 'getFinancialSummary').mockResolvedValue({
        totalGrossVolume: 100000.00,
        totalCommissionEarned: 15000.00,
        totalPartnerPayable: 85000.00,
        totalBookingsCommissioned: 120,
      });

      const res = await request(app)
        .get('/api/v1/admin/financials/summary')
        .set('Authorization', 'Bearer admin-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.totalCommissionEarned).toBe(15000.00);
    });
  });

  describe('Admin Payout Endpoints', () => {
    it('GET /api/v1/admin/payouts returns all partner payouts', async () => {
      jest.spyOn(adminFinancialService, 'listPayouts').mockResolvedValue({
        items: [
          {
            id: payout1Id,
            partnerId: partnerUserId,
            amount: 500.00,
            status: 'REQUESTED',
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
        .get('/api/v1/admin/payouts')
        .set('Authorization', 'Bearer admin-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(1);
    });

    it('PATCH /api/v1/admin/payouts/:payoutId/process moves to PROCESSING', async () => {
      jest.spyOn(adminFinancialService, 'processPayout').mockResolvedValue({
        id: payout1Id,
        status: 'PROCESSING',
      });

      const res = await request(app)
        .patch(`/api/v1/admin/payouts/${payout1Id}/process`)
        .set('Authorization', 'Bearer admin-token')
        .send({ providerTransferId: 'CF_TRF_12345' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('PROCESSING');
    });

    it('PATCH /api/v1/admin/payouts/:payoutId/complete marks payout COMPLETED', async () => {
      jest.spyOn(adminFinancialService, 'completePayout').mockResolvedValue({
        id: payout1Id,
        status: 'COMPLETED',
      });

      const res = await request(app)
        .patch(`/api/v1/admin/payouts/${payout1Id}/complete`)
        .set('Authorization', 'Bearer admin-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('COMPLETED');
    });

    it('PATCH /api/v1/admin/payouts/:payoutId/fail marks payout FAILED and reverses balance', async () => {
      jest.spyOn(adminFinancialService, 'failPayout').mockResolvedValue({
        id: payout1Id,
        status: 'FAILED',
        failureReason: 'Invalid IFSC code',
      });

      const res = await request(app)
        .patch(`/api/v1/admin/payouts/${payout1Id}/fail`)
        .set('Authorization', 'Bearer admin-token')
        .send({ failureReason: 'Invalid IFSC code' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('FAILED');
    });
  });
});
