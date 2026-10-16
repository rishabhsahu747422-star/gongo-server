'use strict';

const adminWalletService = require('../../src/services/admin-wallet.service');
const adminWalletRepository = require('../../src/repositories/admin-wallet.repository');
const cashfreeProvider = require('../../src/providers/cashfree');
const auditService = require('../../src/services/audit.service');
const {
  BadRequestError,
  NotFoundError,
  ConflictError,
} = require('../../src/errors');

describe('Unit: AdminWalletService', () => {
  const TEST_WALLET_ID = 'a2222222-2222-4222-a222-222222222222';
  const TEST_PARTNER_ID = 'b2222222-2222-4222-a222-222222222222';
  const TEST_PAYOUT_ID = 'c2222222-2222-4222-a222-222222222222';
  const TEST_BANK_ACCOUNT_ID = 'd2222222-2222-4222-a222-222222222222';

  const mockAdminUser = {
    id: 'admin-user-001',
    role: 'ADMIN',
    email: 'admin@gongo.com',
  };
  const ACTOR_USER_ID = 'a9999999-9999-4999-a999-999999999999';

  /**
   * Wraps a fake client query implementation so the authenticated admin resolves in users
   * (processed_by must be the actual actor — see security/financial-actor).
   */
  function withActor(impl) {
    return (sql, params) => (/FROM users/i.test(sql)
      ? Promise.resolve({ rows: [{ id: ACTOR_USER_ID }] })
      : impl(sql, params));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    cashfreeProvider.resetMockDelegate();
    jest.spyOn(adminWalletRepository, 'executeInTransaction').mockImplementation(async (cb) => cb({}));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    cashfreeProvider.resetMockDelegate();
  });

  describe('Validation & Guards', () => {
    it('throws BadRequestError for malformed wallet ID', async () => {
      await expect(adminWalletService.getWalletById('not-a-uuid'))
        .rejects.toThrow(BadRequestError);
    });

    it('throws BadRequestError when startDate > endDate', async () => {
      await expect(adminWalletService.listWallets({
        startDate: '2026-05-10',
        endDate: '2026-05-01',
      })).rejects.toThrow(BadRequestError);
    });

    it('throws BadRequestError when date range exceeds 366 days', async () => {
      await expect(adminWalletService.listWallets({
        startDate: '2024-01-01',
        endDate: '2026-01-01',
      })).rejects.toThrow('Date range cannot exceed 366 days');
    });

    it('throws NotFoundError when wallet is not found', async () => {
      jest.spyOn(adminWalletRepository, 'getWalletById').mockResolvedValue(null);

      await expect(adminWalletService.getWalletById(TEST_WALLET_ID))
        .rejects.toThrow(NotFoundError);
    });
  });

  describe('Payout Approval', () => {
    it('throws ConflictError when attempting to approve already COMPLETED payout', async () => {
      jest.spyOn(adminWalletRepository, 'getPayoutForUpdate').mockResolvedValue({
        id: TEST_PAYOUT_ID,
        status: 'COMPLETED',
        amount: '2000.00',
        partner_id: TEST_PARTNER_ID,
      });

      await expect(adminWalletService.approvePayout(
        TEST_PAYOUT_ID,
        {},
        mockAdminUser,
      )).rejects.toThrow(ConflictError);
    });

    it('throws BadRequestError when bank account is not VERIFIED', async () => {
      jest.spyOn(adminWalletRepository, 'getPayoutForUpdate').mockResolvedValue({
        id: TEST_PAYOUT_ID,
        status: 'REQUESTED',
        amount: '2000.00',
        partner_id: TEST_PARTNER_ID,
        bank_account_id: TEST_BANK_ACCOUNT_ID,
      });
      jest.spyOn(adminWalletRepository, 'getWalletByPartnerIdForUpdate').mockResolvedValue({
        id: TEST_WALLET_ID,
        partner_id: TEST_PARTNER_ID,
        available_balance: '5000.00',
      });
      jest.spyOn(adminWalletRepository, 'getBankAccountById').mockResolvedValue({
        id: TEST_BANK_ACCOUNT_ID,
        verificationStatus: 'PENDING',
      });

      await expect(adminWalletService.approvePayout(
        TEST_PAYOUT_ID,
        {},
        mockAdminUser,
      )).rejects.toThrow('Cannot disburse payout to an unverified bank account');
    });

    it('approves payout in REQUESTED status, executes gateway transfer, and records audit', async () => {
      jest.spyOn(adminWalletRepository, 'getPayoutForUpdate').mockResolvedValue({
        id: TEST_PAYOUT_ID,
        status: 'REQUESTED',
        amount: '2000.00',
        partner_id: TEST_PARTNER_ID,
        bank_account_id: TEST_BANK_ACCOUNT_ID,
      });
      jest.spyOn(adminWalletRepository, 'getWalletByPartnerIdForUpdate').mockResolvedValue({
        id: TEST_WALLET_ID,
        partner_id: TEST_PARTNER_ID,
        available_balance: '5000.00',
      });
      jest.spyOn(adminWalletRepository, 'getBankAccountById').mockResolvedValue({
        id: TEST_BANK_ACCOUNT_ID,
        verificationStatus: 'VERIFIED',
        accountNumberMasked: 'XXXX-XXXX-1234',
        ifscCode: 'HDFC0001234',
        accountHolderName: 'Jane Doe',
      });

      cashfreeProvider.setMockDelegate({
        initiatePayoutTransfer: jest.fn().mockResolvedValue({
          providerTransferId: 'cf_pot_123',
          transferStatus: 'SUCCESS',
          utr: 'UTR123456789',
        }),
      });

      jest.spyOn(adminWalletRepository, 'updatePayoutStatus').mockResolvedValue({
        id: TEST_PAYOUT_ID,
        status: 'COMPLETED',
        provider_transfer_id: 'cf_pot_123',
      });
      const auditSpy = jest.spyOn(auditService, 'logAdminAction').mockResolvedValue(true);

      const result = await adminWalletService.approvePayout(
        TEST_PAYOUT_ID,
        { remarks: 'Approved by admin' },
        mockAdminUser,
        { requestId: 'req-1' },
      );

      expect(result.status).toBe('COMPLETED');
      expect(result.provider_transfer_id).toBe('cf_pot_123');
      expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({
        action: 'PAYOUT_APPROVE',
        targetResource: 'payouts',
        targetResourceId: TEST_PAYOUT_ID,
      }));
    });
  });

  describe('Payout Rejection', () => {
    it('requires mandatory rejection reason', async () => {
      await expect(adminWalletService.rejectPayout(
        TEST_PAYOUT_ID,
        { reason: '  ' },
        mockAdminUser,
      )).rejects.toThrow('Rejection reason is mandatory');
    });

    it('updates status to rejected and releases the amount held at request time', async () => {
      jest.spyOn(adminWalletRepository, 'getPayoutForUpdate').mockResolvedValue({
        id: TEST_PAYOUT_ID,
        status: 'PENDING',
        amount: '1500.00',
        partner_id: TEST_PARTNER_ID,
      });
      jest.spyOn(adminWalletRepository, 'getWalletByPartnerIdForUpdate').mockResolvedValue({
        id: TEST_WALLET_ID,
        partner_id: TEST_PARTNER_ID,
        available_balance: '5000.00',
        total_debited: '500.00',
      });

      const holdSpy = jest.spyOn(adminWalletRepository, 'adjustPayoutHold').mockResolvedValue();
      const createTxSpy = jest.spyOn(adminWalletRepository, 'createWalletTransaction').mockResolvedValue({});
      const auditSpy = jest.spyOn(auditService, 'logAdminAction').mockResolvedValue(true);

      const fakeClient = {
        query: jest.fn().mockResolvedValue({
          rows: [{ id: TEST_PAYOUT_ID, status: 'rejected', failure_reason: 'Incorrect bank details' }],
        }),
      };
      jest.spyOn(adminWalletRepository, 'executeInTransaction').mockImplementation(async (cb) => cb(fakeClient));

      const result = await adminWalletService.rejectPayout(
        TEST_PAYOUT_ID,
        { reason: 'Incorrect bank details provided' },
        mockAdminUser,
        { requestId: 'req-2' },
      );

      expect(result.status).toBe('rejected');
      // Partner payout.service debits available balance when the payout is requested,
      // so rejecting must credit it back (and record a CREDIT ledger entry).
      expect(holdSpy).toHaveBeenCalledWith(fakeClient, TEST_PARTNER_ID, 1500);
      expect(createTxSpy).toHaveBeenCalledWith(
        fakeClient,
        expect.objectContaining({ direction: 'CREDIT', amount: 1500, balanceAfter: 6500 }),
      );
      expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({
        action: 'PAYOUT_REJECT',
      }));
    });
  });

  describe('Mark Paid (Manual Payment)', () => {
    it('throws BadRequestError when UTR / payment reference is missing', async () => {
      await expect(adminWalletService.markPaid(
        TEST_PAYOUT_ID,
        { paymentMethod: 'UPI' },
        mockAdminUser,
      )).rejects.toThrow('Payment reference / UTR is mandatory');
    });

    it('throws ConflictError when payout is already PAID or COMPLETED', async () => {
      jest.spyOn(adminWalletRepository, 'getPayoutForUpdate').mockResolvedValue({
        id: TEST_PAYOUT_ID,
        status: 'PAID',
        amount: '2000.00',
        partner_id: TEST_PARTNER_ID,
      });

      await expect(adminWalletService.markPaid(
        TEST_PAYOUT_ID,
        { utr: 'UTR123456789' },
        mockAdminUser,
      )).rejects.toThrow(ConflictError);
    });

    it('marks paid even when the remaining available balance is below the payout amount (already held)', async () => {
      jest.spyOn(adminWalletRepository, 'getPayoutForUpdate').mockResolvedValue({
        id: TEST_PAYOUT_ID,
        status: 'PENDING',
        amount: '4000.00',
        partner_id: TEST_PARTNER_ID,
      });
      jest.spyOn(adminWalletRepository, 'getWalletByPartnerIdForUpdate').mockResolvedValue({
        id: TEST_WALLET_ID,
        partner_id: TEST_PARTNER_ID,
        available_balance: '0.00', // partner withdrew the whole balance; it is held for this payout
        total_debited: '4000.00',
      });
      const updateBalancesSpy = jest.spyOn(adminWalletRepository, 'updateWalletBalances').mockResolvedValue({});
      jest.spyOn(adminWalletRepository, 'createWalletTransaction').mockResolvedValue({ id: 'tx-1' });
      jest.spyOn(auditService, 'logAdminAction').mockResolvedValue(true);
      const fakeClient = {
        query: jest.fn().mockImplementation(withActor((queryText) => Promise.resolve({
          rows: queryText.includes('UPDATE partner_payouts') ? [{ id: TEST_PAYOUT_ID, status: 'paid' }] : [],
        }))),
      };
      jest.spyOn(adminWalletRepository, 'executeInTransaction').mockImplementation(async (cb) => cb(fakeClient));

      const result = await adminWalletService.markPaid(
        TEST_PAYOUT_ID,
        { utr: 'UTR123456789', paymentMethod: 'UPI' },
        mockAdminUser,
      );
      expect(result.payout.status).toBe('paid');
      expect(updateBalancesSpy).not.toHaveBeenCalled();
    });

    it('marks payout PAID with a ledger record and no second wallet deduction', async () => {
      jest.spyOn(adminWalletRepository, 'getPayoutForUpdate').mockResolvedValue({
        id: TEST_PAYOUT_ID,
        status: 'PENDING',
        amount: '4000.00',
        partner_id: TEST_PARTNER_ID,
      });
      jest.spyOn(adminWalletRepository, 'getWalletByPartnerIdForUpdate').mockResolvedValue({
        id: TEST_WALLET_ID,
        partner_id: TEST_PARTNER_ID,
        available_balance: '10000.00',
        total_debited: '0.00',
      });

      const updateBalancesSpy = jest.spyOn(adminWalletRepository, 'updateWalletBalances').mockResolvedValue({});
      const createTxSpy = jest.spyOn(adminWalletRepository, 'createWalletTransaction').mockResolvedValue({
        id: 'tx-123',
        amount: 4000.00,
        direction: 'DEBIT',
      });

      const fakeClient = {
        query: jest.fn().mockImplementation(withActor((queryText) => {
          if (queryText.includes('UPDATE partner_payouts')) {
            return Promise.resolve({
              rows: [{
                id: TEST_PAYOUT_ID,
                status: 'paid',
                payment_reference: 'UTR123456789',
                payment_method: 'UPI',
                processed_by: mockAdminUser.id,
              }],
            });
          }
          return Promise.resolve({ rows: [] });
        })),
      };
      jest.spyOn(adminWalletRepository, 'executeInTransaction').mockImplementation(async (cb) => cb(fakeClient));
      const auditSpy = jest.spyOn(auditService, 'logAdminAction').mockResolvedValue(true);

      const result = await adminWalletService.markPaid(
        TEST_PAYOUT_ID,
        { utr: 'UTR123456789', paymentMethod: 'UPI', notes: 'Manually transferred via GPay' },
        mockAdminUser,
        { requestId: 'req-mark-paid-1' },
      );

      expect(result.payout.status).toBe('paid');
      // The 4000 was debited when the partner requested the payout; paying it out
      // must not deduct it a second time.
      expect(result.wallet.availableBalance).toBe(10000.00);
      expect(updateBalancesSpy).not.toHaveBeenCalled();
      expect(createTxSpy).toHaveBeenCalledWith(
        fakeClient,
        expect.objectContaining({
          transactionType: 'PAYOUT',
          direction: 'DEBIT',
          amount: 4000.00,
          balanceBefore: 10000.00,
          balanceAfter: 10000.00,
        }),
      );
      expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({
        action: 'PAYOUT_MARK_PAID',
        targetResourceId: TEST_PAYOUT_ID,
      }));
    });
  });

  describe('Manual Wallet Adjustment', () => {
    function setup(availableBalance, { existing = null, actorResolves = true } = {}) {
      const fakeClient = {
        query: jest.fn(async (sql) => (/FROM users/i.test(sql) && actorResolves
          ? { rows: [{ id: ACTOR_USER_ID }] }
          : { rows: [] })),
      };
      jest.spyOn(adminWalletRepository, 'executeInTransaction').mockImplementation(async (cb) => cb(fakeClient));
      jest.spyOn(adminWalletRepository, 'getWalletByIdForUpdate').mockResolvedValue({
        id: TEST_WALLET_ID, partner_id: TEST_PARTNER_ID, available_balance: availableBalance,
      });
      const findSpy = jest.spyOn(adminWalletRepository, 'findAdminAdjustmentByKey').mockResolvedValue(existing);
      const balanceSpy = jest.spyOn(adminWalletRepository, 'adjustAvailableBalance').mockResolvedValue();
      const txSpy = jest.spyOn(adminWalletRepository, 'createWalletTransaction').mockResolvedValue({ id: 'tx-adj' });
      const auditSpy = jest.spyOn(auditService, 'logAdminAction').mockResolvedValue(true);
      return { fakeClient, balanceSpy, txSpy, findSpy, auditSpy };
    }

    it('credits the wallet and records a persistent ledger entry with amount, direction, reason, key and actor', async () => {
      const { fakeClient, balanceSpy, txSpy, findSpy } = setup('100.00');
      await adminWalletService.adjustWallet(
        TEST_WALLET_ID,
        { amount: 50, direction: 'credit', reason: 'Goodwill credit', idempotencyKey: '00000000-0000-4000-8000-000000000001' },
        mockAdminUser,
      );
      expect(findSpy).toHaveBeenCalledWith(fakeClient, TEST_PARTNER_ID, '00000000-0000-4000-8000-000000000001');
      expect(balanceSpy).toHaveBeenCalledWith(fakeClient, TEST_PARTNER_ID, 50);
      expect(txSpy).toHaveBeenCalledWith(fakeClient, expect.objectContaining({
        transactionType: 'ADMIN_ADJUSTMENT',
        direction: 'CREDIT',
        amount: 50,
        balanceBefore: 100,
        balanceAfter: 150,
        referenceId: '00000000-0000-4000-8000-000000000001',
        description: 'Goodwill credit',
        metadata: expect.objectContaining({ adjustedBy: ACTOR_USER_ID, idempotencyKey: '00000000-0000-4000-8000-000000000001' }),
      }));
    });

    it('debits with a negative delta and rejects overdrafts', async () => {
      const { fakeClient, balanceSpy } = setup('100.00');
      await adminWalletService.adjustWallet(
        TEST_WALLET_ID,
        { amount: 40, direction: 'debit', reason: 'Damage recovery', idempotencyKey: '00000000-0000-4000-8000-000000000002' },
        mockAdminUser,
      );
      expect(balanceSpy).toHaveBeenCalledWith(fakeClient, TEST_PARTNER_ID, -40);

      await expect(adminWalletService.adjustWallet(
        TEST_WALLET_ID,
        { amount: 500, direction: 'debit', reason: 'Too large', idempotencyKey: '00000000-0000-4000-8000-000000000003' },
        mockAdminUser,
      )).rejects.toThrow('Insufficient wallet balance');
    });

    it('requires an idempotency key', async () => {
      const { balanceSpy, txSpy } = setup('100.00');
      await expect(adminWalletService.adjustWallet(
        TEST_WALLET_ID,
        { amount: 10, direction: 'credit', reason: 'No key given' },
        mockAdminUser,
      )).rejects.toThrow(/Idempotency-Key/);
      expect(balanceSpy).not.toHaveBeenCalled();
      expect(txSpy).not.toHaveBeenCalled();
    });

    it('requires the idempotency key to be a UUID (stored in the UUID reference_id column)', async () => {
      const { balanceSpy, txSpy } = setup('100.00');
      await expect(adminWalletService.adjustWallet(
        TEST_WALLET_ID,
        { amount: 10, direction: 'credit', reason: 'Free-form key', idempotencyKey: 'not-a-uuid-key' },
        mockAdminUser,
      )).rejects.toThrow(/Idempotency-Key \(UUID\)/);
      expect(balanceSpy).not.toHaveBeenCalled();
      expect(txSpy).not.toHaveBeenCalled();
    });

    it('replaying the same key returns the original result without applying it again', async () => {
      const existing = {
        id: 'tx-original', amount: '50.00', direction: 'credit', balance_before: '100.00',
        balance_after: '150.00', description: 'Goodwill credit',
      };
      const { balanceSpy, txSpy, auditSpy } = setup('150.00', { existing });
      const result = await adminWalletService.adjustWallet(
        TEST_WALLET_ID,
        { amount: 50, direction: 'credit', reason: 'Goodwill credit', idempotencyKey: '00000000-0000-4000-8000-000000000001' },
        mockAdminUser,
      );
      expect(result.idempotentReplay).toBe(true);
      expect(result.balanceAfter).toBe(150);
      expect(result.transaction.id).toBe('tx-original');
      expect(balanceSpy).not.toHaveBeenCalled();
      expect(txSpy).not.toHaveBeenCalled();
      expect(auditSpy).not.toHaveBeenCalled();
    });

    it('rejects reuse of a key for a different adjustment with 409', async () => {
      const existing = { id: 'tx-original', amount: '50.00', direction: 'credit', balance_after: '150.00' };
      const { balanceSpy } = setup('150.00', { existing });
      await expect(adminWalletService.adjustWallet(
        TEST_WALLET_ID,
        { amount: 75, direction: 'credit', reason: 'Different amount', idempotencyKey: '00000000-0000-4000-8000-000000000001' },
        mockAdminUser,
      )).rejects.toMatchObject({ statusCode: 409 });
      expect(balanceSpy).not.toHaveBeenCalled();
    });

    it('refuses (403) and writes nothing when the acting admin cannot be resolved', async () => {
      const { txSpy, auditSpy } = setup('100.00', { actorResolves: false });
      await expect(adminWalletService.adjustWallet(
        TEST_WALLET_ID,
        { amount: 10, direction: 'credit', reason: 'Unattributable', idempotencyKey: '00000000-0000-4000-8000-000000000004' },
        mockAdminUser,
      )).rejects.toMatchObject({ statusCode: 403, code: 'ADMIN_ACTOR_UNRESOLVED' });
      // The balance update ran inside the same transaction, which the thrown error rolls back
      expect(txSpy).not.toHaveBeenCalled();
      expect(auditSpy).not.toHaveBeenCalled();
    });
  });

  describe('Payout Retry', () => {
    it('rejects retry if payout is in REQUESTED status', async () => {
      jest.spyOn(adminWalletRepository, 'getPayoutForUpdate').mockResolvedValue({
        id: TEST_PAYOUT_ID,
        status: 'REQUESTED',
      });

      await expect(adminWalletService.retryPayout(
        TEST_PAYOUT_ID,
        {},
        mockAdminUser,
      )).rejects.toThrow('Only FAILED or CANCELLED payouts can be retried');
    });

    it('rejects retry if wallet has insufficient balance', async () => {
      jest.spyOn(adminWalletRepository, 'getPayoutForUpdate').mockResolvedValue({
        id: TEST_PAYOUT_ID,
        status: 'FAILED',
        amount: '3000.00',
        partner_id: TEST_PARTNER_ID,
      });
      jest.spyOn(adminWalletRepository, 'getWalletByPartnerIdForUpdate').mockResolvedValue({
        id: TEST_WALLET_ID,
        partner_id: TEST_PARTNER_ID,
        available_balance: '1500.00',
      });

      await expect(adminWalletService.retryPayout(
        TEST_PAYOUT_ID,
        {},
        mockAdminUser,
      )).rejects.toThrow('Insufficient wallet balance to retry payout');
    });

    it('successfully retries payout, re-debits wallet and updates status', async () => {
      jest.spyOn(adminWalletRepository, 'getPayoutForUpdate').mockResolvedValue({
        id: TEST_PAYOUT_ID,
        status: 'FAILED',
        amount: '1000.00',
        partner_id: TEST_PARTNER_ID,
      });
      jest.spyOn(adminWalletRepository, 'getWalletByPartnerIdForUpdate').mockResolvedValue({
        id: TEST_WALLET_ID,
        partner_id: TEST_PARTNER_ID,
        available_balance: '2000.00',
        total_debited: '500.00',
      });

      const holdSpy = jest.spyOn(adminWalletRepository, 'adjustPayoutHold').mockResolvedValue();
      const createTxSpy = jest.spyOn(adminWalletRepository, 'createWalletTransaction').mockResolvedValue({});
      jest.spyOn(adminWalletRepository, 'updatePayoutStatus').mockResolvedValue({
        id: TEST_PAYOUT_ID,
        status: 'REQUESTED',
      });
      const auditSpy = jest.spyOn(auditService, 'logAdminAction').mockResolvedValue(true);

      const result = await adminWalletService.retryPayout(
        TEST_PAYOUT_ID,
        {},
        mockAdminUser,
        { requestId: 'req-3' },
      );

      expect(result.status).toBe('REQUESTED');
      // Re-applies the hold (released by the failure reversal) on both wallet tables
      expect(holdSpy).toHaveBeenCalledWith(expect.anything(), TEST_PARTNER_ID, -1000);
      expect(createTxSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          transactionType: 'PAYOUT',
          direction: 'DEBIT',
          amount: 1000.00,
          balanceAfter: 1000.00,
        }),
      );
      expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({
        action: 'PAYOUT_RETRY',
      }));
    });
  });
});
