'use strict';

const WalletRepository = require('../../src/repositories/wallet.repository');

describe('Unit: WalletRepository', () => {
  let walletRepo;
  let mockClient;

  const partnerId = '11111111-1111-4111-a111-111111111111';
  const walletId = 'wal-uuid-001';

  beforeEach(() => {
    walletRepo = new WalletRepository();
    mockClient = {
      query: jest.fn(),
    };
  });

  describe('findByPartnerId', () => {
    it('returns wallet row when partner exists', async () => {
      const mockWallet = {
        id: walletId,
        partner_id: partnerId,
        available_balance: '500.00',
        pending_balance: '0.00',
        total_credited: '500.00',
      };
      mockClient.query.mockResolvedValue({ rows: [mockWallet] });

      const result = await walletRepo.findByPartnerId(partnerId, mockClient);

      expect(result).toEqual(mockWallet);
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE partner_id = $1'),
        [partnerId],
      );
    });

    it('returns null when partner wallet does not exist', async () => {
      mockClient.query.mockResolvedValue({ rows: [] });

      const result = await walletRepo.findByPartnerId(partnerId, mockClient);

      expect(result).toBeNull();
    });
  });

  describe('findByPartnerIdForUpdate', () => {
    it('executes SELECT FOR UPDATE within transaction client', async () => {
      const mockWallet = {
        id: walletId,
        partner_id: partnerId,
        available_balance: '1000.00',
        total_credited: '1000.00',
      };
      mockClient.query.mockResolvedValue({ rows: [mockWallet] });

      const result = await walletRepo.findByPartnerIdForUpdate(partnerId, mockClient);

      expect(result).toEqual(mockWallet);
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringMatching(/FOR UPDATE/i),
        [partnerId],
      );
    });

    it('throws error if client is missing (transaction safety guard)', async () => {
      await expect(walletRepo.findByPartnerIdForUpdate(partnerId, null)).rejects.toThrow(
        /requires an active database transaction client/i,
      );
    });
  });

  describe('updateBalances', () => {
    it('updates available_balance and total_credited and returns updated row', async () => {
      const updatedRow = {
        id: walletId,
        partner_id: partnerId,
        available_balance: '1500.00',
        total_credited: '1500.00',
      };
      mockClient.query.mockResolvedValue({ rows: [updatedRow] });

      const result = await walletRepo.updateBalances(
        walletId,
        { availableBalance: 1500.00, totalCredited: 1500.00 },
        mockClient,
      );

      expect(result).toEqual(updatedRow);
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE\s+wallets\s+SET\s+available_balance\s*=\s*\$1,\s*total_credited\s*=\s*\$2/i),
        [1500.00, 1500.00, walletId],
      );
    });

    it('throws error if balances are negative', async () => {
      await expect(
        walletRepo.updateBalances(
          walletId,
          { availableBalance: -10, totalCredited: 100 },
          mockClient,
        ),
      ).rejects.toThrow(/cannot be negative/i);

      await expect(
        walletRepo.updateBalances(
          walletId,
          { availableBalance: 100, totalCredited: -5 },
          mockClient,
        ),
      ).rejects.toThrow(/cannot be negative/i);
    });
  });

  describe('creditWallet', () => {
    it('locks wallet, calculates server-side balances, and updates atomically', async () => {
      const initialWallet = {
        id: walletId,
        partner_id: partnerId,
        available_balance: '1000.00',
        total_credited: '1000.00',
      };
      const updatedWallet = {
        id: walletId,
        partner_id: partnerId,
        available_balance: '1500.00',
        total_credited: '1500.00',
      };

      mockClient.query
        .mockResolvedValueOnce({ rows: [initialWallet] }) // findByPartnerIdForUpdate
        .mockResolvedValueOnce({ rows: [updatedWallet] }); // updateBalances

      const result = await walletRepo.creditWallet(partnerId, 500.00, mockClient);

      expect(result).not.toBeNull();
      expect(result.previousAvailable).toBe(1000.00);
      expect(result.newAvailable).toBe(1500.00);
      expect(result.creditAmount).toBe(500.00);
      expect(result.wallet).toEqual(updatedWallet);
    });

    it('rejects zero or negative credit amounts', async () => {
      await expect(walletRepo.creditWallet(partnerId, 0, mockClient)).rejects.toThrow(
        /must be a positive number/i,
      );
      await expect(walletRepo.creditWallet(partnerId, -50, mockClient)).rejects.toThrow(
        /must be a positive number/i,
      );
      await expect(walletRepo.creditWallet(partnerId, 'invalid', mockClient)).rejects.toThrow(
        /must be a positive number/i,
      );
    });

    it('returns null if partner wallet is not found', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] }); // not found

      const result = await walletRepo.creditWallet(partnerId, 100, mockClient);

      expect(result).toBeNull();
    });
  });
});
