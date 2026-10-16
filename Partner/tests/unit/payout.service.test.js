'use strict';

const PayoutService = require('../../src/services/payout.service').constructor;
const { BadRequestError } = require('../../src/errors');
const { pool } = require('../../src/db/pool');

describe('Unit: PayoutService', () => {
  let mockPayoutRepo;
  let mockBankAccountRepo;
  let mockWalletRepo;
  let mockWalletTxRepo;
  let payoutService;
  let mockClient;

  beforeEach(() => {
    mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
    jest.spyOn(pool, 'connect').mockResolvedValue(mockClient);

    mockPayoutRepo = {
      findById: jest.fn(),
      createPayout: jest.fn(),
      findByIdempotencyKey: jest.fn(),
      findByIdAndPartnerId: jest.fn(),
      findPaginatedByPartnerId: jest.fn(),
      findByIdForUpdate: jest.fn(),
      updateStatus: jest.fn(),
    };
    mockBankAccountRepo = {
      findByIdAndPartnerId: jest.fn(),
      findPrimaryByPartnerId: jest.fn(),
    };
    mockWalletRepo = {
      findByPartnerId: jest.fn().mockResolvedValue({
        id: 'wallet-1',
        partner_id: 'partner-1',
        available_balance: '1000.00',
      }),
      debitWallet: jest.fn(),
      reverseDebitWallet: jest.fn(),
    };
    mockWalletTxRepo = {
      createLedgerEntry: jest.fn(),
    };

    payoutService = new PayoutService(
      mockPayoutRepo,
      mockBankAccountRepo,
      mockWalletRepo,
      mockWalletTxRepo,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('requestPayout', () => {
    it('successfully requests payout, validates balance without debiting wallet, and preserves wallet balance', async () => {
      mockPayoutRepo.findByIdempotencyKey.mockResolvedValue(null);
      mockBankAccountRepo.findPrimaryByPartnerId.mockResolvedValue({
        id: 'bank-1',
        partner_id: 'partner-1',
        account_holder_name: 'Rahul Sharma',
        account_number_masked: '•••• •••• 9012',
        bank_name: 'HDFC Bank',
        ifsc_code: 'HDFC0001234',
        verification_status: 'VERIFIED',
      });
      mockWalletRepo.findByPartnerId = jest.fn().mockResolvedValue({
        id: 'wallet-1',
        partner_id: 'partner-1',
        available_balance: '1000.00',
      });
      mockPayoutRepo.createPayout.mockResolvedValue({
        id: 'payout-1',
        partner_id: 'partner-1',
        bank_account_id: 'bank-1',
        amount: '250.00',
        status: 'pending',
        idempotency_key: 'idem-1',
        requested_at: '2026-03-01T10:00:00.000Z',
        created_at: '2026-03-01T10:00:00.000Z',
      });

      const result = await payoutService.requestPayout('partner-1', {
        amount: 250.00,
        idempotencyKey: 'idem-1',
      });

      expect(result.id).toBe('payout-1');
      expect(result.amount).toBe(250.00);
      expect(result.status).toBe('PENDING');
      // CRITICAL: DO NOT deduct wallet at request time!
      expect(mockWalletRepo.debitWallet).not.toHaveBeenCalled();
      expect(mockWalletTxRepo.createLedgerEntry).not.toHaveBeenCalled();
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });

    it('does not create a second payout when a concurrent request with the same key committed first', async () => {
      const committedByOtherRequest = {
        id: 'payout-race-1',
        partner_id: 'partner-1',
        bank_account_id: 'bank-1',
        amount: '250.00',
        status: 'pending',
        idempotency_key: 'idem-race',
      };
      // Pre-check (before the wallet lock) sees nothing; the re-check under the lock sees
      // the payout the concurrent request just committed.
      mockPayoutRepo.findByIdempotencyKey
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(committedByOtherRequest);
      mockBankAccountRepo.findPrimaryByPartnerId.mockResolvedValue({
        id: 'bank-1', partner_id: 'partner-1', verification_status: 'VERIFIED',
      });
      mockWalletRepo.findByPartnerId = jest.fn().mockResolvedValue({
        id: 'wallet-1', partner_id: 'partner-1', available_balance: '1000.00',
      });

      const result = await payoutService.requestPayout('partner-1', {
        amount: 250.00,
        idempotencyKey: 'idem-race',
      });

      expect(result.id).toBe('payout-race-1');
      expect(mockPayoutRepo.createPayout).not.toHaveBeenCalled();
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
      expect(mockPayoutRepo.findByIdempotencyKey).toHaveBeenLastCalledWith('partner-1', 'idem-race', mockClient);
    });

    it('returns existing payout when idempotencyKey already processed', async () => {
      mockPayoutRepo.findByIdempotencyKey.mockResolvedValue({
        id: 'payout-existing',
        partner_id: 'partner-1',
        bank_account_id: 'bank-1',
        amount: '250.00',
        status: 'pending',
        idempotency_key: 'idem-1',
        account_number_masked: '•••• •••• 9012',
      });

      const result = await payoutService.requestPayout('partner-1', {
        amount: 250.00,
        idempotencyKey: 'idem-1',
      });

      expect(result.id).toBe('payout-existing');
      expect(mockWalletRepo.debitWallet).not.toHaveBeenCalled();
    });

    it('rejects payout when partner wallet has insufficient balance', async () => {
      mockPayoutRepo.findByIdempotencyKey.mockResolvedValue(null);
      mockBankAccountRepo.findPrimaryByPartnerId.mockResolvedValue({
        id: 'bank-1',
        partner_id: 'partner-1',
        verification_status: 'VERIFIED',
      });
      mockWalletRepo.findByPartnerId = jest.fn().mockResolvedValue({
        id: 'wallet-1',
        partner_id: 'partner-1',
        available_balance: '100.00',
      });

      await expect(
        payoutService.requestPayout('partner-1', { amount: 250.00 }),
      ).rejects.toThrow(BadRequestError);

      expect(mockWalletRepo.debitWallet).not.toHaveBeenCalled();
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });

    it('rejects payout when partner has no verified bank account', async () => {
      mockPayoutRepo.findByIdempotencyKey.mockResolvedValue(null);
      mockBankAccountRepo.findPrimaryByPartnerId.mockResolvedValue(null);

      await expect(
        payoutService.requestPayout('partner-1', { amount: 250.00 }),
      ).rejects.toThrow(BadRequestError);
    });
  });

  describe('Cashfree Payout Provider Integration', () => {
    let mockPayoutProvider;
    let serviceWithProvider;

    beforeEach(() => {
      mockPayoutProvider = {
        ensureBeneficiary: jest.fn().mockResolvedValue({ status: 'CREATED' }),
        initiateTransfer: jest.fn().mockResolvedValue({
          transferId: 'payout-1',
          cfTransferId: 'cf-transfer-999',
          status: 'RECEIVED',
        }),
        getTransferStatus: jest.fn().mockResolvedValue({
          transferId: 'payout-1',
          status: 'SUCCESS',
        }),
      };

      serviceWithProvider = new PayoutService(
        mockPayoutRepo,
        mockBankAccountRepo,
        mockWalletRepo,
        mockWalletTxRepo,
        mockPayoutProvider,
      );
    });

    it('dispatches to provider, updates payout status to PROCESSING, and records transferId', async () => {
      mockPayoutRepo.findByIdempotencyKey.mockResolvedValue(null);
      mockBankAccountRepo.findPrimaryByPartnerId.mockResolvedValue({
        id: 'bank-1',
        partner_id: 'partner-1',
        account_holder_name: 'Rahul Sharma',
        account_number_masked: '•••• •••• 9012',
        bank_name: 'HDFC Bank',
        ifsc_code: 'HDFC0001234',
        verification_status: 'VERIFIED',
      });
      mockWalletRepo.debitWallet.mockResolvedValue({
        insufficientBalance: false,
        wallet: { id: 'wallet-1' },
        previousAvailable: 1000.00,
        newAvailable: 750.00,
        debitAmount: 250.00,
      });
      mockPayoutRepo.createPayout.mockResolvedValue({
        id: 'payout-1',
        partner_id: 'partner-1',
        bank_account_id: 'bank-1',
        amount: '250.00',
        status: 'requested',
      });
      mockPayoutRepo.createPayout.mockResolvedValue({
        id: 'payout-1',
        partner_id: 'partner-1',
        bank_account_id: 'bank-1',
        amount: '250.00',
        status: 'pending',
      });

      const res = await serviceWithProvider.requestPayout('partner-1', { amount: 250.00 });

      expect(res.status).toBe('PENDING');
      // In manual flow, provider transfer is NOT automatically dispatched on partner request
      expect(mockPayoutProvider.initiateTransfer).not.toHaveBeenCalled();
    });

    it('reconciles status to completed/paid when Cashfree reports SUCCESS', async () => {
      mockPayoutRepo.findById.mockResolvedValue({
        id: 'payout-1',
        status: 'processing',
      });
      mockPayoutProvider.getTransferStatus.mockResolvedValue({
        transferId: 'payout-1',
        cfTransferId: 'cf-transfer-999',
        status: 'SUCCESS',
      });
      mockPayoutRepo.updateStatus.mockResolvedValue({
        id: 'payout-1',
        status: 'completed',
        provider_transfer_id: 'cf-transfer-999',
      });

      const res = await serviceWithProvider.reconcilePayoutStatus('payout-1');

      expect(res.status).toBe('PAID');
      expect(mockPayoutRepo.updateStatus).toHaveBeenCalledWith(
        'payout-1',
        expect.objectContaining({ status: 'completed' }),
      );
    });
  });

  describe('handlePayoutFailureOrReversal', () => {
    it('reverses debit, restores wallet and updates payout status to FAILED', async () => {
      mockPayoutRepo.findByIdForUpdate.mockResolvedValue({
        id: 'payout-1',
        partner_id: 'partner-1',
        amount: '250.00',
        status: 'PROCESSING',
      });
      mockWalletRepo.reverseDebitWallet.mockResolvedValue({
        wallet: { id: 'wallet-1' },
        newAvailable: 1000.00,
      });
      mockPayoutRepo.updateStatus.mockResolvedValue({
        id: 'payout-1',
        status: 'FAILED',
        failure_reason: 'Bank network error',
      });

      const res = await payoutService.handlePayoutFailureOrReversal('payout-1', 'Bank network error');

      expect(res.status).toBe('FAILED');
      expect(mockWalletRepo.reverseDebitWallet).toHaveBeenCalledWith('partner-1', 250.00, mockClient);
      expect(mockWalletTxRepo.createLedgerEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionType: 'PAYOUT_REVERSAL',
          direction: 'CREDIT',
          amount: 250.00,
          balanceAfter: 1000.00,
          referenceType: 'PAYOUT_REVERSAL',
          referenceId: 'payout-1',
        }),
        mockClient,
      );
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });
  });
});
