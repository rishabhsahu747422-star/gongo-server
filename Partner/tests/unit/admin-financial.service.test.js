'use strict';

const AdminFinancialService = require('../../src/services/admin-financial.service').constructor;
const payoutService = require('../../src/services/payout.service');
const { NotFoundError, BadRequestError } = require('../../src/errors');

describe('Unit: AdminFinancialService', () => {
  let mockEarningsRepo;
  let mockCommissionRepo;
  let mockPayoutRepo;
  let adminFinancialService;

  beforeEach(() => {
    mockEarningsRepo = {
      findPaginatedAdmin: jest.fn(),
    };
    mockCommissionRepo = {
      findPaginated: jest.fn(),
      getCommissionSummary: jest.fn(),
    };
    mockPayoutRepo = {
      findPaginatedAdmin: jest.fn(),
      findByIdAdmin: jest.fn(),
      updateStatus: jest.fn(),
    };

    adminFinancialService = new AdminFinancialService(
      mockEarningsRepo,
      mockCommissionRepo,
      mockPayoutRepo,
    );
  });

  describe('listSettlements', () => {
    it('returns platform-wide settlements with partner details', async () => {
      mockEarningsRepo.findPaginatedAdmin.mockResolvedValue({
        rows: [
          {
            id: 'earn-1',
            partner_id: 'partner-1',
            partner_name: 'Super Rentals',
            booking_id: 'b-1',
            booking_number: 'BK-1001',
            gross_amount: '500.00',
            partner_net_amount: '425.00',
            settlement_status: 'SETTLED',
            settled_at: '2026-03-01T10:00:00.000Z',
          },
        ],
        total: 1,
      });

      const res = await adminFinancialService.listSettlements({ page: 1, limit: 20 });
      expect(res.items).toHaveLength(1);
      expect(res.items[0].partnerName).toBe('Super Rentals');
      expect(res.items[0].grossAmount).toBe(500.00);
      expect(res.items[0].partnerNetAmount).toBe(425.00);
    });
  });

  describe('listCommissions', () => {
    it('returns confidential commission records', async () => {
      mockCommissionRepo.findPaginated.mockResolvedValue({
        rows: [
          {
            id: 'comm-1',
            booking_id: 'b-1',
            booking_number: 'BK-1001',
            partner_id: 'partner-1',
            partner_name: 'Super Rentals',
            commission_type: 'PERCENTAGE',
            commission_rate: '0.1500',
            commission_amount: '75.00',
            gross_booking_amount: '500.00',
            partner_payable_amount: '425.00',
            status: 'CALCULATED',
          },
        ],
        total: 1,
      });

      const res = await adminFinancialService.listCommissions({ page: 1, limit: 20 });
      expect(res.items).toHaveLength(1);
      expect(res.items[0].commissionAmount).toBe(75.00);
      expect(res.items[0].commissionRate).toBe(0.1500);
    });
  });

  describe('completePayout & failPayout', () => {
    it('completes payout when in PROCESSING status', async () => {
      mockPayoutRepo.findByIdAdmin.mockResolvedValue({
        id: 'payout-1',
        partner_id: 'partner-1',
        amount: '1000.00',
        status: 'PROCESSING',
      });
      mockPayoutRepo.updateStatus.mockResolvedValue({
        id: 'payout-1',
        status: 'COMPLETED',
      });

      const res = await adminFinancialService.completePayout('payout-1');
      expect(mockPayoutRepo.updateStatus).toHaveBeenCalledWith('payout-1', { status: 'COMPLETED' });
      expect(res.id).toBe('payout-1');
    });

    it('fails payout and triggers balance restoration', async () => {
      mockPayoutRepo.findByIdAdmin.mockResolvedValue({
        id: 'payout-1',
        partner_id: 'partner-1',
        amount: '1000.00',
        status: 'PROCESSING',
      });
      jest.spyOn(payoutService, 'handlePayoutFailureOrReversal').mockResolvedValue({});

      const res = await adminFinancialService.failPayout('payout-1', {
        failureReason: 'Beneficiary name mismatch',
      });

      expect(payoutService.handlePayoutFailureOrReversal).toHaveBeenCalledWith(
        'payout-1',
        'Beneficiary name mismatch',
      );
      expect(res.id).toBe('payout-1');
    });

    it('rejects action on non-existent payout with NotFoundError', async () => {
      mockPayoutRepo.findByIdAdmin.mockResolvedValue(null);

      await expect(
        adminFinancialService.completePayout('payout-missing'),
      ).rejects.toThrow(NotFoundError);
    });

    it('throws BadRequestError when attempting to complete a FAILED payout', async () => {
      mockPayoutRepo.findByIdAdmin.mockResolvedValue({
        id: 'payout-failed',
        partner_id: 'partner-1',
        amount: '1000.00',
        status: 'FAILED',
      });

      await expect(
        adminFinancialService.completePayout('payout-failed'),
      ).rejects.toThrow(BadRequestError);
    });

    it('idempotently returns payout when already COMPLETED', async () => {
      mockPayoutRepo.findByIdAdmin.mockResolvedValue({
        id: 'payout-done',
        partner_id: 'partner-1',
        amount: '1000.00',
        status: 'COMPLETED',
      });

      const res = await adminFinancialService.completePayout('payout-done');
      expect(res.id).toBe('payout-done');
      expect(res.status).toBe('COMPLETED');
    });
  });
});
