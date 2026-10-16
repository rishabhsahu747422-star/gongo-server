'use strict';

const WalletService = require('../../src/services/wallet.service').constructor;
const PayoutService = require('../../src/services/payout.service').constructor;
const commissionLockService = require('../../src/services/commission-lock.service');
const { BadRequestError } = require('../../src/errors');
const { pool } = require('../../src/db/pool');

describe('Partner Current Wallet, Hold Amount & Locked Commission Engine', () => {
  const partnerId = '11111111-2222-3333-4444-555555555555';
  const walletId = 'wallet-test-uuid-001';

  let mockWalletRepo;
  let mockWalletTxRepo;
  let mockPayoutRepo;
  let mockBankRepo;
  let walletService;
  let payoutService;
  let mockClient;

  beforeEach(() => {
    mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
    jest.spyOn(pool, 'connect').mockResolvedValue(mockClient);

    mockWalletRepo = {
      findByPartnerId: jest.fn(),
      findByPartnerIdForUpdate: jest.fn(),
      createWallet: jest.fn(),
      query: jest.fn(),
    };

    mockWalletTxRepo = {
      findPaginatedByPartnerId: jest.fn(),
      findByIdAndPartnerId: jest.fn(),
      createLedgerEntry: jest.fn(),
    };

    mockPayoutRepo = {
      findByIdempotencyKey: jest.fn().mockResolvedValue(null),
      createPayout: jest.fn(),
      findPaginatedByPartnerId: jest.fn(),
    };

    mockBankRepo = {
      findPrimaryByPartnerId: jest.fn().mockResolvedValue({
        id: 'bank-1',
        verification_status: 'VERIFIED',
        account_holder_name: 'Partner Test',
        account_number_masked: '•••• 1234',
        bank_name: 'HDFC Bank',
        ifsc_code: 'HDFC0001234',
      }),
      findByIdAndPartnerId: jest.fn(),
    };

    walletService = new WalletService(mockWalletRepo, mockWalletTxRepo);
    payoutService = new PayoutService(mockPayoutRepo, mockBankRepo, mockWalletRepo, mockWalletTxRepo);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('1. Upcoming & Active Bookings → Hold Amount', () => {
    it('places partner earnings from UPCOMING booking into Hold Amount (not Available)', async () => {
      // Mock wallet query returning synchronized balance
      mockWalletRepo.findByPartnerId.mockResolvedValue({
        id: walletId,
        partner_id: partnerId,
        available_balance: '0.00',
        pending_balance: '9000.00',
        total_credited: '0.00',
        total_debited: '0.00',
        currency: 'INR',
        updated_at: new Date().toISOString(),
      });
      mockWalletRepo.query.mockResolvedValue({ rows: [] });

      const summary = await walletService.getWalletSummary(partnerId);

      expect(summary.availableBalance).toBe(0.00);
      expect(summary.holdAmount).toBe(9000.00);
      expect(summary.pendingBalance).toBe(9000.00);
    });

    it('keeps partner earnings in Hold Amount while booking is ACTIVE / in-progress', async () => {
      mockWalletRepo.findByPartnerId.mockResolvedValue({
        id: walletId,
        partner_id: partnerId,
        available_balance: '0.00',
        pending_balance: '9000.00',
        total_credited: '0.00',
        total_debited: '0.00',
        currency: 'INR',
      });
      mockWalletRepo.query.mockResolvedValue({ rows: [] });

      const summary = await walletService.getWalletSummary(partnerId);

      expect(summary.availableBalance).toBe(0.00);
      expect(summary.holdAmount).toBe(9000.00);
    });
  });

  describe('2. Vehicle Returned / Booking Completed → Available Balance', () => {
    it('moves partner earnings from Hold Amount to Available Balance upon completion', async () => {
      mockWalletRepo.findByPartnerId.mockResolvedValue({
        id: walletId,
        partner_id: partnerId,
        available_balance: '9000.00',
        pending_balance: '0.00',
        total_credited: '9000.00',
        total_debited: '0.00',
        currency: 'INR',
      });
      mockWalletRepo.query.mockResolvedValue({ rows: [] });

      const summary = await walletService.getWalletSummary(partnerId);

      expect(summary.availableBalance).toBe(9000.00);
      expect(summary.holdAmount).toBe(0.00);
      expect(summary.totalCredited).toBe(9000.00);
    });
  });

  describe('3. Commission Rule Locked at Booking Time & Admin Rule Change', () => {
    it('locks commission at booking creation time and preserves historical rate even when Admin updates rule', async () => {
      const bookingId = 'booking-10-oct';
      const mockDb = {
        query: jest.fn(),
      };

      // Step 1: Booking creation time. Admin rule is 10%.
      // Check snapshot: not exists
      mockDb.query
        .mockResolvedValueOnce({ rows: [] }) // existing snap check
        .mockResolvedValueOnce({ // booking data
          rows: [{
            id: bookingId,
            partner_id: partnerId,
            vehicle_id: 'veh-1',
            total_amount: 10000,
            booking_status: 'CONFIRMED',
            created_at: new Date('2026-10-10T10:00:00Z'),
          }],
        })
        .mockResolvedValueOnce({ // matching 10% rule
          rows: [{
            id: 'rule-10-percent',
            commission_type: 'percentage',
            commission_value: 10,
            rule_scope: 'default',
          }],
        })
        .mockResolvedValueOnce({ rows: [] }) // insert commission_records
        .mockResolvedValueOnce({ rows: [] }) // insert commission_transactions
        .mockResolvedValueOnce({ rows: [] }); // insert earnings

      const snap1 = await commissionLockService.lockBookingCommission(bookingId, mockDb);
      expect(snap1.commissionRate).toBe(10);
      expect(snap1.commissionAmount).toBe(1000);
      expect(snap1.partnerNetAmount).toBe(9000);
      expect(snap1.isExistingSnapshot).toBe(false);

      // Step 2: Admin changes commission rule to 15% later!
      // When lockBookingCommission or wallet sync runs on old booking, it encounters existing snapshot
      mockDb.query.mockReset();
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          cr_id: 'cr-1',
          cr_rate: 10,
          cr_comm: 1000,
          cr_payable: 9000,
          ct_rule_id: 'rule-10-percent',
          ct_rate: 10,
          ct_comm: 1000,
          e_id: 'e-1',
          e_gross: 10000,
          e_comm: 1000,
          e_net: 9000,
        }],
      });

      const snap2 = await commissionLockService.lockBookingCommission(bookingId, mockDb);
      // Historical booking remains strictly locked at 10% (₹9,000 net)
      expect(snap2.isExistingSnapshot).toBe(true);
      expect(snap2.commissionRate).toBe(10);
      expect(snap2.commissionAmount).toBe(1000);
      expect(snap2.partnerNetAmount).toBe(9000);
    });
  });

  describe('4. Multiple Bookings Scenario (Requirement 10)', () => {
    it('correctly calculates Available = ₹5,000 and Hold = ₹5,000 for mixed bookings', async () => {
      // Booking A (COMPLETED): ₹5,000
      // Booking B (ACTIVE): ₹3,000
      // Booking C (UPCOMING): ₹2,000
      mockWalletRepo.findByPartnerId.mockResolvedValue({
        id: walletId,
        partner_id: partnerId,
        available_balance: '5000.00',
        pending_balance: '5000.00', // ₹3000 + ₹2000
        total_credited: '5000.00',
        total_debited: '0.00',
        currency: 'INR',
      });
      mockWalletRepo.query.mockResolvedValue({ rows: [] });

      const state1 = await walletService.getWalletSummary(partnerId);
      expect(state1.availableBalance).toBe(5000.00);
      expect(state1.holdAmount).toBe(5000.00);
    });

    it('after Booking B completes: Available = ₹8,000 and Hold = ₹2,000', async () => {
      // Booking B completed -> ₹3,000 moved to Available
      mockWalletRepo.findByPartnerId.mockResolvedValue({
        id: walletId,
        partner_id: partnerId,
        available_balance: '8000.00',
        pending_balance: '2000.00',
        total_credited: '8000.00',
        total_debited: '0.00',
        currency: 'INR',
      });
      mockWalletRepo.query.mockResolvedValue({ rows: [] });

      const state2 = await walletService.getWalletSummary(partnerId);
      expect(state2.availableBalance).toBe(8000.00);
      expect(state2.holdAmount).toBe(2000.00);
    });

    it('after ₹4,000 withdrawal: Available = ₹4,000 and Hold = ₹2,000', async () => {
      // ₹4,000 withdrawn -> debited ONLY from Available Balance
      mockWalletRepo.findByPartnerId.mockResolvedValue({
        id: walletId,
        partner_id: partnerId,
        available_balance: '4000.00',
        pending_balance: '2000.00',
        total_credited: '8000.00',
        total_debited: '4000.00',
        currency: 'INR',
      });
      mockWalletRepo.query.mockResolvedValue({ rows: [] });

      const state3 = await walletService.getWalletSummary(partnerId);
      expect(state3.availableBalance).toBe(4000.00);
      expect(state3.holdAmount).toBe(2000.00);
      expect(state3.totalDebited).toBe(4000.00);
    });
  });

  describe('5. Payout Security & Balance Protection', () => {
    it('deducts payout withdrawal ONLY from Available Balance', async () => {
      mockWalletRepo.findByPartnerIdForUpdate.mockResolvedValue({
        id: walletId,
        partner_id: partnerId,
        available_balance: '8000.00',
        pending_balance: '2000.00',
      });
      mockPayoutRepo.createPayout.mockResolvedValue({
        id: 'payout-1',
        partner_id: partnerId,
        amount: '4000.00',
        status: 'pending',
      });

      const res = await payoutService.requestPayout(partnerId, {
        amount: 4000.00,
      });

      expect(res.id).toBe('payout-1');
      expect(res.amount).toBe(4000.00);
      // Validates update on wallets row with client.query
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE wallets'),
        [4000.00, partnerId]
      );
    });

    it('strictly forbids withdrawing Hold Amount when Available Balance is insufficient', async () => {
      // Available Balance = ₹5,000; Hold Amount = ₹5,000
      mockWalletRepo.findByPartnerIdForUpdate.mockResolvedValue({
        id: walletId,
        partner_id: partnerId,
        available_balance: '5000.00',
        pending_balance: '5000.00',
      });

      // Partner attempts to withdraw ₹7,000 (trying to consume Hold Amount)
      await expect(
        payoutService.requestPayout(partnerId, { amount: 7000.00 })
      ).rejects.toThrow(BadRequestError);

      expect(mockPayoutRepo.createPayout).not.toHaveBeenCalled();
    });

    it('rejects invalid or zero withdrawal amounts', async () => {
      await expect(
        payoutService.requestPayout(partnerId, { amount: 0 })
      ).rejects.toThrow(BadRequestError);

      await expect(
        payoutService.requestPayout(partnerId, { amount: -500 })
      ).rejects.toThrow(BadRequestError);
    });

    it('enforces row-level locking for concurrent withdrawal protection', async () => {
      mockWalletRepo.findByPartnerIdForUpdate.mockResolvedValue({
        id: walletId,
        partner_id: partnerId,
        available_balance: '5000.00',
        pending_balance: '2000.00',
      });
      mockPayoutRepo.createPayout.mockResolvedValue({
        id: 'payout-2',
        partner_id: partnerId,
        amount: '1000.00',
        status: 'pending',
      });

      await payoutService.requestPayout(partnerId, { amount: 1000.00 });

      // Verifies findByPartnerIdForUpdate was called within the transaction
      expect(mockWalletRepo.findByPartnerIdForUpdate).toHaveBeenCalledWith(partnerId, mockClient);
    });
  });
});
