'use strict';

const PayoutRepository = require('../../src/repositories/payout.repository');

describe('Unit: PayoutRepository', () => {
  let payoutRepo;
  let mockClient;

  beforeEach(() => {
    payoutRepo = new PayoutRepository();
    mockClient = {
      query: jest.fn(),
    };
  });

  describe('constructor', () => {
    it('targets partner_payouts table', () => {
      expect(payoutRepo.tableName).toBe('partner_payouts');
    });
  });

  describe('createPayout', () => {
    it('normalizes status to lowercase to satisfy partner_payouts_status_check constraint', async () => {
      mockClient.query.mockResolvedValue({
        rows: [
          {
            id: 'payout-123',
            partner_id: 'partner-1',
            bank_account_id: 'bank-1',
            amount: '200.00',
            status: 'requested',
          },
        ],
      });

      const res = await payoutRepo.createPayout(
        {
          partnerId: 'partner-1',
          bankAccountId: 'bank-1',
          amount: 200.00,
          status: 'REQUESTED',
          idempotencyKey: 'idem-123',
        },
        mockClient,
      );

      expect(mockClient.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockClient.query.mock.calls[0];
      expect(sql).toContain('INSERT INTO partner_payouts');
      expect(params[3]).toBe('requested');
      expect(res.id).toBe('payout-123');
      expect(res.status).toBe('requested');
    });

    it('defaults status to lowercase requested when not specified', async () => {
      mockClient.query.mockResolvedValue({
        rows: [{ id: 'payout-456', status: 'requested' }],
      });

      await payoutRepo.createPayout(
        {
          partnerId: 'partner-1',
          bankAccountId: 'bank-1',
          amount: 500.00,
        },
        mockClient,
      );

      const [, params] = mockClient.query.mock.calls[0];
      expect(params[3]).toBe('requested');
    });
  });

  describe('updateStatus', () => {
    it('normalizes uppercase status to lowercase in update query', async () => {
      mockClient.query.mockResolvedValue({
        rows: [{ id: 'payout-123', status: 'failed', failure_reason: 'Bank rejected' }],
      });

      await payoutRepo.updateStatus(
        'payout-123',
        { status: 'FAILED', failureReason: 'Bank rejected' },
        mockClient,
      );

      expect(mockClient.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockClient.query.mock.calls[0];
      expect(sql).toContain('UPDATE partner_payouts');
      expect(params[0]).toBe('failed');
      expect(params[2]).toBe('Bank rejected');
    });
  });

  describe('findPaginatedByPartnerId', () => {
    it('normalizes uppercase status filter to lowercase for query', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [{ total: 1 }] })
        .mockResolvedValueOnce({ rows: [{ id: 'payout-1', status: 'requested' }] });

      await payoutRepo.findPaginatedByPartnerId(
        'partner-1',
        { status: 'REQUESTED', limit: 10, offset: 0 },
        mockClient,
      );

      const [countSql, countParams] = mockClient.query.mock.calls[0];
      expect(countSql).toContain('p.status = $2');
      expect(countParams[1]).toBe('requested');

      const [dataSql, dataParams] = mockClient.query.mock.calls[1];
      expect(dataSql).toContain('p.status = $2');
      expect(dataParams[1]).toBe('requested');
    });
  });
});
