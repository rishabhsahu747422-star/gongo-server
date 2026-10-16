'use strict';

const WalletTransactionRepository = require('../../src/repositories/wallet-transaction.repository');
const {
  WALLET_TRANSACTION_TYPE,
  TRANSACTION_DIRECTION,
  TRANSACTION_STATUS,
  WALLET_REFERENCE_TYPE,
} = require('../../src/constants/wallet');

describe('Unit: WalletTransactionRepository', () => {
  let walletTxRepo;
  let mockClient;

  const partnerId = '11111111-1111-4111-a111-111111111111';
  const walletId = 'wal-uuid-001';
  const paymentId = 'pay-uuid-001';

  beforeEach(() => {
    walletTxRepo = new WalletTransactionRepository();
    mockClient = {
      query: jest.fn(),
    };
  });

  describe('createLedgerEntry', () => {
    it('creates immutable ledger record with backend-owned parameters', async () => {
      const mockRecord = {
        id: 'tx-uuid-001',
        wallet_id: walletId,
        partner_id: partnerId,
        transaction_type: WALLET_TRANSACTION_TYPE.SETTLEMENT_PAYMENT,
        direction: TRANSACTION_DIRECTION.CREDIT,
        amount: '500.00',
        balance_after: '1500.00',
        reference_type: WALLET_REFERENCE_TYPE.POST_RENTAL_SETTLEMENT,
        reference_id: paymentId,
        status: TRANSACTION_STATUS.COMPLETED,
        description: 'Post-rental settlement credit',
        metadata: { bookingId: 'bk-01' },
        created_at: new Date().toISOString(),
      };
      mockClient.query.mockResolvedValue({ rows: [mockRecord] });

      const result = await walletTxRepo.createLedgerEntry(
        {
          walletId,
          partnerId,
          transactionType: WALLET_TRANSACTION_TYPE.SETTLEMENT_PAYMENT,
          direction: TRANSACTION_DIRECTION.CREDIT,
          amount: 500.00,
          balanceAfter: 1500.00,
          referenceType: WALLET_REFERENCE_TYPE.POST_RENTAL_SETTLEMENT,
          referenceId: paymentId,
          status: TRANSACTION_STATUS.COMPLETED,
          description: 'Post-rental settlement credit',
          metadata: { bookingId: 'bk-01' },
        },
        mockClient,
      );

      expect(result).toEqual(mockRecord);
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringMatching(/INSERT INTO wallet_transactions/i),
        expect.arrayContaining([
          walletId,
          partnerId,
          'booking_earning',
          'credit',
          500.00,
          1500.00,
          'booking',
          paymentId,
        ]),
      );
    });

    it('throws error if transaction client is not provided', async () => {
      await expect(
        walletTxRepo.createLedgerEntry({
          walletId,
          partnerId,
          transactionType: WALLET_TRANSACTION_TYPE.SETTLEMENT_PAYMENT,
          direction: TRANSACTION_DIRECTION.CREDIT,
          amount: 500,
          balanceAfter: 1500,
          referenceType: WALLET_REFERENCE_TYPE.POST_RENTAL_SETTLEMENT,
          referenceId: paymentId,
        }, null),
      ).rejects.toThrow(/requires an active database transaction client/i);
    });
  });

  describe('findByReference', () => {
    it('returns existing transaction when found', async () => {
      const mockRecord = {
        id: 'tx-uuid-001',
        reference_type: WALLET_REFERENCE_TYPE.POST_RENTAL_SETTLEMENT,
        reference_id: paymentId,
        direction: TRANSACTION_DIRECTION.CREDIT,
      };
      mockClient.query.mockResolvedValue({ rows: [mockRecord] });

      const result = await walletTxRepo.findByReference({
        referenceType: WALLET_REFERENCE_TYPE.POST_RENTAL_SETTLEMENT,
        referenceId: paymentId,
        direction: TRANSACTION_DIRECTION.CREDIT,
        client: mockClient,
      });

      expect(result).toEqual(mockRecord);
      // Rows are stored as reference_type 'booking' / direction 'credit' (createLedgerEntry);
      // the lookup must match that stored form (and the legacy as-named form).
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringMatching(/WHERE\s+reference_id\s*=\s*\$1\s+AND\s+LOWER\(reference_type\)\s+IN\s+\(\$2,\s*\$3\)\s+AND\s+LOWER\(direction\)\s+IN\s+\(\$4\)/i),
        [paymentId, 'booking', 'post_rental_settlement', 'credit'],
      );
    });

    it('round-trip: finds the ledger entry createLedgerEntry wrote (settlement idempotency barrier)', async () => {
      // eslint-disable-next-line global-require
      const { newDb } = require('pg-mem');
      const db = newDb();
      // Live vocabulary: lowercase direction/type/reference (see constants/wallet.js)
      db.public.none(`
        CREATE TABLE wallet_transactions (
          id SERIAL PRIMARY KEY,
          wallet_id TEXT NOT NULL, partner_id TEXT NOT NULL,
          transaction_type VARCHAR(30) NOT NULL,
          direction VARCHAR(10) NOT NULL CHECK (direction IN ('credit', 'debit')),
          amount NUMERIC(12,2) NOT NULL, balance_before NUMERIC(12,2), balance_after NUMERIC(12,2) NOT NULL,
          reference_type VARCHAR(50) NOT NULL, reference_id VARCHAR(100) NOT NULL,
          status VARCHAR(30) NOT NULL DEFAULT 'COMPLETED', description TEXT, metadata JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      const { Client } = db.adapters.createPg();
      const client = new Client();
      await client.connect();

      await walletTxRepo.createLedgerEntry({
        walletId: 'w-1',
        partnerId: 'p-1',
        transactionType: 'SETTLEMENT_PAYMENT',
        direction: TRANSACTION_DIRECTION.CREDIT,
        amount: 500,
        balanceAfter: 1500,
        referenceType: WALLET_REFERENCE_TYPE.POST_RENTAL_SETTLEMENT,
        referenceId: 'pay-rt-1',
      }, client);

      const found = await walletTxRepo.findByReference({
        referenceType: WALLET_REFERENCE_TYPE.POST_RENTAL_SETTLEMENT,
        referenceId: 'pay-rt-1',
        direction: TRANSACTION_DIRECTION.CREDIT,
        client,
      });
      expect(found).not.toBeNull();
      expect(found.direction).toBe('credit');
      expect(found.reference_type).toBe('booking');

      // A legacy row written with uppercase names is still recognised
      await client.query(
        `INSERT INTO wallet_transactions (wallet_id, partner_id, transaction_type, direction, amount, balance_after, reference_type, reference_id)
         VALUES ('w-1', 'p-1', 'payout', 'debit', 100, 1400, 'PAYOUT', 'po-legacy-1')`,
      );
      const legacy = await walletTxRepo.findByReference({
        referenceType: 'PAYOUT', referenceId: 'po-legacy-1', direction: 'DEBIT', client,
      });
      expect(legacy).not.toBeNull();
      await client.end();
    });

    it('rejects an invalid ledger direction before writing', async () => {
      const query = jest.fn();
      await expect(walletTxRepo.createLedgerEntry({
        walletId: 'w-1',
        partnerId: 'p-1',
        transactionType: 'PAYOUT',
        direction: 'SIDEWAYS',
        amount: 1,
        balanceAfter: 0,
        referenceType: 'PAYOUT',
        referenceId: 'x',
      }, { query })).rejects.toThrow(/Invalid ledger direction/);
      expect(query).not.toHaveBeenCalled();
    });

    it('returns null when transaction is not found', async () => {
      mockClient.query.mockResolvedValue({ rows: [] });

      const result = await walletTxRepo.findByReference({
        referenceType: WALLET_REFERENCE_TYPE.POST_RENTAL_SETTLEMENT,
        referenceId: 'non-existent',
        client: mockClient,
      });

      expect(result).toBeNull();
    });
  });

  describe('Immutability verification', () => {
    it('does not expose update or delete methods on the repository', () => {
      expect(walletTxRepo.update).toBeUndefined();
      expect(walletTxRepo.updateById).toBeUndefined();
      expect(walletTxRepo.delete).toBeUndefined();
      expect(walletTxRepo.deleteById).toBeUndefined();
      expect(walletTxRepo.modify).toBeUndefined();
    });
  });
});
