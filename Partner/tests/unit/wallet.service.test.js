'use strict';

const WalletService = require('../../src/services/wallet.service');
const { NotFoundError } = require('../../src/errors');

describe('Unit: WalletService', () => {
  let mockWalletRepo;
  let mockWalletTxRepo;
  let walletService;

  const partnerId = '11111111-1111-4111-a111-111111111111';
  const walletId = '22222222-2222-4222-a222-222222222222';
  const transactionId = '33333333-3333-4333-a333-333333333333';

  beforeEach(() => {
    mockWalletRepo = {
      findByPartnerId: jest.fn(),
      createWallet: jest.fn(),
    };

    mockWalletTxRepo = {
      findPaginatedByPartnerId: jest.fn(),
      findByIdAndPartnerId: jest.fn(),
    };

    walletService = new WalletService.constructor(mockWalletRepo, mockWalletTxRepo);
  });

  describe('getWalletSummary', () => {
    it('returns formatted numerical balances when wallet exists', async () => {
      mockWalletRepo.findByPartnerId.mockResolvedValue({
        id: walletId,
        partner_id: partnerId,
        available_balance: '1500.50',
        pending_balance: '250.00',
        total_credited: '2000.00',
        total_debited: '249.50',
        currency: 'INR',
        updated_at: '2026-09-22T10:00:00.000Z',
      });

      const result = await walletService.getWalletSummary(partnerId);

      expect(result).toEqual({
        walletId,
        partnerId,
        availableBalance: 1500.50,
        holdAmount: 250.00,
        pendingBalance: 250.00,
        totalCredited: 2000.00,
        totalDebited: 249.50,
        currency: 'INR',
        updatedAt: '2026-09-22T10:00:00.000Z',
      });
      expect(mockWalletRepo.findByPartnerId).toHaveBeenCalledWith(partnerId);
    });

    it('returns default zero balance representation when wallet is not found', async () => {
      mockWalletRepo.findByPartnerId.mockResolvedValue(null);

      const result = await walletService.getWalletSummary(partnerId);

      expect(result).toEqual({
        walletId: null,
        partnerId,
        availableBalance: 0.00,
        holdAmount: 0.00,
        pendingBalance: 0.00,
        totalCredited: 0.00,
        totalDebited: 0.00,
        currency: 'INR',
        updatedAt: null,
      });
    });
  });

  describe('getTransactionHistory', () => {
    it('returns paginated transactions with calculated pagination metadata', async () => {
      const mockRows = [
        {
          id: transactionId,
          wallet_id: walletId,
          partner_id: partnerId,
          transaction_type: 'SETTLEMENT_PAYMENT',
          direction: 'CREDIT',
          amount: '500.00',
          balance_after: '1500.00',
          reference_type: 'POST_RENTAL_SETTLEMENT',
          reference_id: 'pay-01',
          status: 'COMPLETED',
          description: 'Settlement credit',
          metadata: { bookingId: 'bk-01' },
          created_at: '2026-09-22T10:00:00.000Z',
        },
      ];

      mockWalletTxRepo.findPaginatedByPartnerId.mockResolvedValue({
        rows: mockRows,
        total: 1,
      });

      const options = { page: 1, limit: 20, offset: 0 };
      const result = await walletService.getTransactionHistory(partnerId, options);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toEqual({
        id: transactionId,
        transactionType: 'SETTLEMENT_PAYMENT',
        direction: 'CREDIT',
        amount: 500.00,
        balanceAfter: 1500.00,
        referenceType: 'POST_RENTAL_SETTLEMENT',
        referenceId: 'pay-01',
        status: 'COMPLETED',
        description: 'Settlement credit',
        metadata: { bookingId: 'bk-01' },
        createdAt: '2026-09-22T10:00:00.000Z',
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

    it('handles empty transaction list correctly', async () => {
      mockWalletTxRepo.findPaginatedByPartnerId.mockResolvedValue({
        rows: [],
        total: 0,
      });

      const result = await walletService.getTransactionHistory(partnerId, { page: 1, limit: 20 });

      expect(result.items).toHaveLength(0);
      expect(result.pagination.totalItems).toBe(0);
      expect(result.pagination.totalPages).toBe(1);
    });
  });

  describe('getTransactionDetails', () => {
    it('returns transaction details when found and owned by partner', async () => {
      const mockTx = {
        id: transactionId,
        wallet_id: walletId,
        partner_id: partnerId,
        transaction_type: 'SETTLEMENT_PAYMENT',
        direction: 'CREDIT',
        amount: '350.00',
        balance_after: '1350.00',
        reference_type: 'POST_RENTAL_SETTLEMENT',
        reference_id: 'pay-02',
        status: 'COMPLETED',
        description: 'Settlement credit for booking #BK-100',
        metadata: { bookingId: 'bk-100' },
        created_at: '2026-09-22T11:00:00.000Z',
      };
      mockWalletTxRepo.findByIdAndPartnerId.mockResolvedValue(mockTx);

      const result = await walletService.getTransactionDetails(partnerId, transactionId);

      expect(result.id).toBe(transactionId);
      expect(result.amount).toBe(350.00);
      expect(result.balanceAfter).toBe(1350.00);
      expect(mockWalletTxRepo.findByIdAndPartnerId).toHaveBeenCalledWith(transactionId, partnerId);
    });

    it('throws NotFoundError when transaction does not belong to partner (BOLA protection)', async () => {
      mockWalletTxRepo.findByIdAndPartnerId.mockResolvedValue(null);

      await expect(
        walletService.getTransactionDetails(partnerId, transactionId),
      ).rejects.toThrow(NotFoundError);
      expect(mockWalletTxRepo.findByIdAndPartnerId).toHaveBeenCalledWith(transactionId, partnerId);
    });
  });
});
