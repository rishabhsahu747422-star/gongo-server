'use strict';

const EarningsService = require('../../src/services/earnings.service').constructor;
const { NotFoundError } = require('../../src/errors');

describe('Unit: EarningsService', () => {
  let mockEarningsRepo;
  let earningsService;

  beforeEach(() => {
    mockEarningsRepo = {
      findPaginatedByPartnerId: jest.fn(),
      getSummaryByPartnerId: jest.fn(),
      findByIdAndPartnerId: jest.fn(),
    };
    earningsService = new EarningsService(mockEarningsRepo);
  });

  describe('getEarnings', () => {
    it('returns formatted earnings list with pagination metadata', async () => {
      mockEarningsRepo.findPaginatedByPartnerId.mockResolvedValue({
        rows: [
          {
            id: 'earn-1',
            partner_id: 'partner-1',
            booking_id: 'book-1',
            booking_number: 'BK-1001',
            wallet_transaction_id: 'tx-1',
            gross_amount: '250.00',
            partner_net_amount: '250.00',
            settlement_status: 'SETTLED',
            settled_at: '2026-03-01T10:00:00.000Z',
            created_at: '2026-03-01T10:00:00.000Z',
            updated_at: '2026-03-01T10:00:00.000Z',
          },
        ],
        total: 1,
      });

      const result = await earningsService.getEarnings('partner-1', { page: 1, limit: 20 });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toEqual({
        id: 'earn-1',
        partnerId: 'partner-1',
        bookingId: 'book-1',
        bookingNumber: 'BK-1001',
        walletTransactionId: 'tx-1',
        grossAmount: 250.00,
        partnerNetAmount: 250.00,
        settlementStatus: 'SETTLED',
        settledAt: '2026-03-01T10:00:00.000Z',
        createdAt: '2026-03-01T10:00:00.000Z',
        updatedAt: '2026-03-01T10:00:00.000Z',
      });
      expect(result.pagination).toEqual({
        page: 1,
        limit: 20,
        totalItems: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPrevPage: false,
      });
    });
  });

  describe('getEarningsSummary', () => {
    it('returns aggregated metrics for partner', async () => {
      mockEarningsRepo.getSummaryByPartnerId.mockResolvedValue({
        totalGrossEarnings: 500,
        totalNetEarnings: 500,
        totalSettled: 500,
        totalPending: 0,
        totalRecords: 2,
        settledCount: 2,
        pendingCount: 0,
      });

      const summary = await earningsService.getEarningsSummary('partner-1');
      expect(summary.totalGrossEarnings).toBe(500);
      expect(summary.totalSettled).toBe(500);
      expect(summary.settledCount).toBe(2);
    });
  });

  describe('getEarningById', () => {
    it('returns single earning details when partner owns the record', async () => {
      mockEarningsRepo.findByIdAndPartnerId.mockResolvedValue({
        id: 'earn-1',
        partner_id: 'partner-1',
        booking_id: 'book-1',
        booking_number: 'BK-1001',
        wallet_transaction_id: 'tx-1',
        gross_amount: '150.00',
        partner_net_amount: '150.00',
        settlement_status: 'SETTLED',
        settled_at: '2026-03-01T10:00:00.000Z',
        created_at: '2026-03-01T10:00:00.000Z',
        updated_at: '2026-03-01T10:00:00.000Z',
      });

      const result = await earningsService.getEarningById('partner-1', 'earn-1');
      expect(result.id).toBe('earn-1');
      expect(result.partnerNetAmount).toBe(150.00);
      expect(result.bookingNumber).toBe('BK-1001');
    });

    it('throws NotFoundError if record not found or belongs to another partner (BOLA)', async () => {
      mockEarningsRepo.findByIdAndPartnerId.mockResolvedValue(null);

      await expect(
        earningsService.getEarningById('partner-1', 'earn-foreign'),
      ).rejects.toThrow(NotFoundError);
    });
  });
});
