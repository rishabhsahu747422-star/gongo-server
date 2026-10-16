'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const walletService = require('../../src/services/wallet.service');

describe('Integration: Partner Wallet & Immutable Transaction Ledger Visibility APIs (Phase 12B)', () => {
  let app;
  let mockAuth;

  const partner1Id = '11111111-1111-4111-a111-111111111111';
  const partner2Id = '22222222-2222-4222-a222-222222222222';
  const tx1Id = '33333333-3333-4333-a333-333333333333';

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

  describe('GET /api/v1/partner/wallet', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(app).get('/api/v1/partner/wallet');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns wallet summary for authenticated partner', async () => {
      jest.spyOn(walletService.walletRepository, 'findByPartnerId').mockResolvedValue({
        id: 'wal-01',
        partner_id: partner1Id,
        available_balance: '1500.00',
        pending_balance: '0.00',
        total_credited: '1500.00',
        total_debited: '0.00',
        currency: 'INR',
        updated_at: '2026-09-22T10:00:00.000Z',
      });

      const res = await request(app)
        .get('/api/v1/partner/wallet')
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({
        walletId: 'wal-01',
        partnerId: partner1Id,
        availableBalance: 1500.00,
        // holdAmount is the canonical field consumed by Partner app EarningsScreen/AppContext;
        // pendingBalance mirrors it for backwards compatibility (wallet.service.js)
        holdAmount: 0.00,
        pendingBalance: 0.00,
        totalCredited: 1500.00,
        totalDebited: 0.00,
        currency: 'INR',
        updatedAt: '2026-09-22T10:00:00.000Z',
      });
      expect(walletService.walletRepository.findByPartnerId).toHaveBeenCalledWith(partner1Id);
    });
  });

  describe('GET /api/v1/partner/wallet/transactions', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(app).get('/api/v1/partner/wallet/transactions');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns paginated ledger transactions for authenticated partner', async () => {
      const mockRows = [
        {
          id: tx1Id,
          wallet_id: 'wal-01',
          partner_id: partner1Id,
          transaction_type: 'SETTLEMENT_PAYMENT',
          direction: 'CREDIT',
          amount: '500.00',
          balance_after: '1500.00',
          reference_type: 'POST_RENTAL_SETTLEMENT',
          reference_id: 'pay-001',
          status: 'COMPLETED',
          description: 'Settlement credit for booking #BK-001',
          metadata: { bookingId: 'bk-001' },
          created_at: '2026-09-22T10:00:00.000Z',
        },
      ];

      jest.spyOn(walletService.walletTransactionRepository, 'findPaginatedByPartnerId')
        .mockResolvedValue({ rows: mockRows, total: 1 });

      const res = await request(app)
        .get('/api/v1/partner/wallet/transactions?page=1&limit=10&direction=CREDIT')
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].id).toBe(tx1Id);
      expect(res.body.data.items[0].amount).toBe(500.00);
      expect(res.body.data.pagination).toEqual({
        page: 1,
        limit: 10,
        totalItems: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPrevPage: false,
      });
      expect(
        walletService.walletTransactionRepository.findPaginatedByPartnerId,
      ).toHaveBeenCalledWith(
        partner1Id,
        expect.objectContaining({ page: 1, limit: 10, direction: 'CREDIT' }),
      );
    });

    it('rejects invalid query parameters with 400', async () => {
      const res = await request(app)
        .get('/api/v1/partner/wallet/transactions?direction=INVALID_DIR')
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /api/v1/partner/wallet/transactions/:transactionId', () => {
    it('returns single transaction details for owned transaction', async () => {
      const mockTx = {
        id: tx1Id,
        wallet_id: 'wal-01',
        partner_id: partner1Id,
        transaction_type: 'SETTLEMENT_PAYMENT',
        direction: 'CREDIT',
        amount: '500.00',
        balance_after: '1500.00',
        reference_type: 'POST_RENTAL_SETTLEMENT',
        reference_id: 'pay-001',
        status: 'COMPLETED',
        description: 'Settlement credit for booking #BK-001',
        metadata: { bookingId: 'bk-001' },
        created_at: '2026-09-22T10:00:00.000Z',
      };

      jest.spyOn(walletService.walletTransactionRepository, 'findByIdAndPartnerId')
        .mockResolvedValue(mockTx);

      const res = await request(app)
        .get(`/api/v1/partner/wallet/transactions/${tx1Id}`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(tx1Id);
      expect(res.body.data.amount).toBe(500.00);
      expect(walletService.walletTransactionRepository.findByIdAndPartnerId).toHaveBeenCalledWith(
        tx1Id,
        partner1Id,
      );
    });

    it('enforces strict BOLA: returns 404 when Partner 2 attempts to query Partner 1 transaction', async () => {
      // Partner 2 tries to access tx1Id (which belongs to Partner 1)
      jest.spyOn(walletService.walletTransactionRepository, 'findByIdAndPartnerId')
        .mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/v1/partner/wallet/transactions/${tx1Id}`)
        .set('Authorization', 'Bearer partner-2-token');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(walletService.walletTransactionRepository.findByIdAndPartnerId).toHaveBeenCalledWith(
        tx1Id,
        partner2Id,
      );
    });

    it('rejects malformed non-UUID transactionId with 400', async () => {
      const res = await request(app)
        .get('/api/v1/partner/wallet/transactions/not-a-valid-uuid')
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });
});
