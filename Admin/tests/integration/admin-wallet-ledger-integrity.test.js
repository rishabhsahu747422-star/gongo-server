'use strict';

/**
 * Ledger / balance integrity for Admin financial operations, executed against pg-mem with
 * the real repository SQL and real BEGIN/COMMIT/ROLLBACK (db/pool transaction()).
 *
 * Schema notes:
 * - wallet_transactions uses the live storage vocabulary: direction 'credit'/'debit'
 *   (lowercase CHECK), transaction_type 'admin_adjustment'/'payout'/'refund_adjustment'.
 * - wallets and partner_wallets are separate tables here (two-table layout). In the live
 *   Supabase layout wallets is a view over partner_wallets; pg-mem cannot emulate an
 *   updatable view, so that layout is covered by the copy-not-reapply design, not here.
 * - Real PostgreSQL row-lock concurrency is NOT exercised by pg-mem.
 */

const { newDb } = require('pg-mem');
const { setMockPool, resetMockPool } = require('../../src/db/pool');
const adminWalletService = require('../../src/services/admin-wallet.service');
const adminWalletRepository = require('../../src/repositories/admin-wallet.repository');
const auditService = require('../../src/services/audit.service');

const PARTNER_ID = 'b1111111-1111-4111-a111-111111111111';
const WALLET_ID = 'c1111111-1111-4111-a111-111111111111';
const ADMIN_ID = 'a1111111-1111-4111-a111-111111111111';
const PAYOUT_ID = 'd1111111-1111-4111-a111-111111111111';
const ADMIN = { id: ADMIN_ID, role: 'admin', email: 'finance@example.com' };

let db;

function buildDb() {
  const mem = newDb();
  mem.public.none(`
    CREATE TABLE users (id UUID PRIMARY KEY, email TEXT, role TEXT);
    CREATE TABLE wallets (id UUID PRIMARY KEY, partner_id UUID UNIQUE, available_balance NUMERIC(12,2),
      pending_balance NUMERIC(12,2) DEFAULT 0, total_credited NUMERIC(12,2), total_debited NUMERIC(12,2),
      currency TEXT DEFAULT 'INR', updated_at TIMESTAMPTZ);
    CREATE TABLE partner_wallets (id UUID PRIMARY KEY, partner_id UUID UNIQUE, available_balance NUMERIC(12,2),
      pending_balance NUMERIC(12,2) DEFAULT 0, receivable_balance NUMERIC(12,2) DEFAULT 0,
      total_earned NUMERIC(12,2) DEFAULT 0, total_paid_out NUMERIC(12,2), total_credited NUMERIC(12,2),
      total_debited NUMERIC(12,2), currency TEXT DEFAULT 'INR', created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ);
    CREATE TABLE wallet_transactions (
      id SERIAL PRIMARY KEY, wallet_id UUID NOT NULL, partner_id UUID NOT NULL,
      transaction_type VARCHAR(30) NOT NULL,
      direction VARCHAR(10) NOT NULL CHECK (direction IN ('credit', 'debit')),
      amount NUMERIC(12,2) NOT NULL CHECK (amount > 0), balance_before NUMERIC(12,2),
      balance_after NUMERIC(12,2) NOT NULL, reference_type VARCHAR(50) NOT NULL,
      reference_id UUID NOT NULL, status VARCHAR(30) NOT NULL DEFAULT 'COMPLETED',
      description TEXT, metadata JSONB, created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE partner_payouts (id UUID PRIMARY KEY, partner_id UUID, amount NUMERIC(12,2), status TEXT,
      failure_reason TEXT, notes TEXT, processed_by UUID, processed_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
      payment_reference TEXT, provider_transfer_id TEXT, payment_method TEXT, updated_at TIMESTAMPTZ);

    INSERT INTO users VALUES ('${ADMIN_ID}', 'finance@example.com', 'admin');
    -- Partner earned 1000 and requested a 300 payout, which was held (debited) at request time
    INSERT INTO wallets VALUES ('${WALLET_ID}', '${PARTNER_ID}', 700, 0, 1000, 300, 'INR', now());
    INSERT INTO partner_wallets (id, partner_id, available_balance, total_paid_out, total_credited, total_debited)
      VALUES ('${WALLET_ID}', '${PARTNER_ID}', 700, 300, 1000, 300);
    INSERT INTO partner_payouts (id, partner_id, amount, status) VALUES ('${PAYOUT_ID}', '${PARTNER_ID}', 300, 'pending');
  `);
  const { Pool } = mem.adapters.createPg();
  setMockPool(new Pool());
  return mem;
}

const balances = () => ({
  wallets: Number(db.public.one(`SELECT available_balance FROM wallets WHERE partner_id = '${PARTNER_ID}'`).available_balance),
  mirror: Number(db.public.one(`SELECT available_balance FROM partner_wallets WHERE partner_id = '${PARTNER_ID}'`).available_balance),
});
const ledger = () => db.public.many('SELECT * FROM wallet_transactions ORDER BY id');

beforeEach(() => {
  db = buildDb();
  jest.spyOn(auditService, 'logAdminAction').mockResolvedValue(true);
});
afterEach(() => {
  jest.restoreAllMocks();
  resetMockPool();
});

describe('Admin wallet adjustment', () => {
  it('applies a credit once to both wallet stores and records a lowercase-vocabulary ledger row', async () => {
    const result = await adminWalletService.adjustWallet(
      WALLET_ID,
      { amount: 50, direction: 'credit', reason: 'Goodwill credit', idempotencyKey: '00000000-0000-4000-8000-0000000000a1' },
      ADMIN,
    );
    expect(result.balanceAfter).toBe(750);
    expect(balances()).toEqual({ wallets: 750, mirror: 750 });

    const rows = ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      direction: 'credit',
      transaction_type: 'admin_adjustment',
      reference_type: 'admin',
      reference_id: '00000000-0000-4000-8000-0000000000a1',
      wallet_id: WALLET_ID,
      description: 'Goodwill credit',
    }));
    expect(rows[0].metadata.adjustedBy).toBe(ADMIN_ID);

    // Duplicate request (same key) is a no-op replay
    const replay = await adminWalletService.adjustWallet(
      WALLET_ID,
      { amount: 50, direction: 'credit', reason: 'Goodwill credit', idempotencyKey: '00000000-0000-4000-8000-0000000000a1' },
      ADMIN,
    );
    expect(replay.idempotentReplay).toBe(true);
    expect(ledger()).toHaveLength(1);
    expect(balances()).toEqual({ wallets: 750, mirror: 750 });
  });

  it('ends the transaction with ROLLBACK (never COMMIT) when the ledger write fails', async () => {
    // pg-mem's pg adapter ignores ROLLBACK, so rows cannot be shown to revert here; what is
    // verifiable is that the balance update and the failure share one transaction and that
    // it is rolled back rather than committed. Real PostgreSQL undo is a staging check.
    const statements = [];
    const { Pool } = db.adapters.createPg();
    const inner = new Pool();
    setMockPool({
      connect: async () => {
        const client = await inner.connect();
        return {
          query: (sql, params) => { statements.push(String(sql).trim().split(/\s+/)[0].toUpperCase()); return client.query(sql, params); },
          release: () => client.release(),
        };
      },
      query: (sql, params) => inner.query(sql, params),
    });
    jest.spyOn(adminWalletRepository, 'createWalletTransaction').mockRejectedValue(new Error('ledger insert failed'));

    await expect(adminWalletService.adjustWallet(
      WALLET_ID,
      { amount: 50, direction: 'credit', reason: 'Will fail', idempotencyKey: '00000000-0000-4000-8000-0000000000a2' },
      ADMIN,
    )).rejects.toThrow('ledger insert failed');

    expect(statements[0]).toBe('BEGIN');
    expect(statements).toContain('UPDATE'); // the balance change ran inside this transaction
    expect(statements[statements.length - 1]).toBe('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(ledger()).toHaveLength(0);
  });

  it('refuses an unattributable adjustment and changes nothing', async () => {
    await expect(adminWalletService.adjustWallet(
      WALLET_ID,
      { amount: 50, direction: 'credit', reason: 'Ghost admin', idempotencyKey: '00000000-0000-4000-8000-0000000000a3' },
      { id: 'f9999999-9999-4999-a999-999999999999', role: 'admin', email: 'nobody@example.com' },
    )).rejects.toMatchObject({ statusCode: 403 });
    expect(balances()).toEqual({ wallets: 700, mirror: 700 });
    expect(ledger()).toHaveLength(0);
  });
});

describe('Admin payout decisions', () => {
  it('reject releases the held amount exactly once and records the actor', async () => {
    await adminWalletService.rejectPayout(PAYOUT_ID, { reason: 'Bank details invalid' }, ADMIN);
    expect(balances()).toEqual({ wallets: 1000, mirror: 1000 });
    const payout = db.public.one(`SELECT status, processed_by FROM partner_payouts WHERE id = '${PAYOUT_ID}'`);
    expect(payout.status).toBe('rejected');
    expect(payout.processed_by).toBe(ADMIN_ID);
    const rows = ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ direction: 'credit', reference_id: PAYOUT_ID }));
    expect(Number(db.public.one(`SELECT total_paid_out FROM partner_wallets WHERE partner_id = '${PARTNER_ID}'`).total_paid_out)).toBe(0);
  });

  it('mark-paid does not deduct the held amount a second time', async () => {
    await adminWalletService.markPaid(PAYOUT_ID, { utr: 'UTR123456789', paymentMethod: 'UPI' }, ADMIN);
    expect(balances()).toEqual({ wallets: 700, mirror: 700 });
    const payout = db.public.one(`SELECT status, processed_by FROM partner_payouts WHERE id = '${PAYOUT_ID}'`);
    expect(payout.status).toBe('paid');
    expect(payout.processed_by).toBe(ADMIN_ID);
    const rows = ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ direction: 'debit', reference_id: PAYOUT_ID }));
    expect(Number(rows[0].balance_before)).toBe(700);
    expect(Number(rows[0].balance_after)).toBe(700);
  });

  it('a payout decision by an unresolvable admin is refused and rolled back', async () => {
    await expect(adminWalletService.rejectPayout(
      PAYOUT_ID,
      { reason: 'Bank details invalid' },
      { id: 'f9999999-9999-4999-a999-999999999999', role: 'admin', email: 'nobody@example.com' },
    )).rejects.toMatchObject({ statusCode: 403 });
    expect(balances()).toEqual({ wallets: 700, mirror: 700 });
    expect(db.public.one(`SELECT status FROM partner_payouts WHERE id = '${PAYOUT_ID}'`).status).toBe('pending');
    expect(ledger()).toHaveLength(0);
  });
});

describe('Ledger value validation and historical compatibility', () => {
  it('rejects an invalid direction before writing', async () => {
    await expect(adminWalletRepository.executeInTransaction((client) => adminWalletRepository.createWalletTransaction(client, {
      walletId: WALLET_ID, partnerId: PARTNER_ID, transactionType: 'ADMIN_ADJUSTMENT', direction: 'SIDEWAYS',
      amount: 1, balanceAfter: 1, referenceType: 'ADMIN', referenceId: 'x-1',
    }))).rejects.toThrow(/Invalid ledger direction/);
    expect(ledger()).toHaveLength(0);
  });

  it('the database constraint rejects values outside the storage vocabulary', () => {
    expect(() => db.public.none(`
      INSERT INTO wallet_transactions (wallet_id, partner_id, transaction_type, direction, amount, balance_after, reference_type, reference_id)
      VALUES ('${WALLET_ID}', '${PARTNER_ID}', 'payout', 'sideways', 1, 1, 'payout', 'bad-1')
    `)).toThrow();
  });

  it('direction and type filters match both stored lowercase and legacy uppercase rows', async () => {
    // A ledger table without the lowercase CHECK, holding one stored-vocabulary row and one
    // legacy row written as-named, as can exist in databases older than the CHECK.
    const legacyDb = newDb();
    legacyDb.public.none(`
      CREATE TABLE wallet_transactions (id SERIAL PRIMARY KEY, wallet_id UUID, partner_id UUID,
        transaction_type TEXT, direction TEXT, amount NUMERIC(12,2), balance_before NUMERIC(12,2),
        balance_after NUMERIC(12,2), reference_type TEXT, reference_id UUID, status TEXT DEFAULT 'COMPLETED',
        description TEXT, metadata JSONB, created_at TIMESTAMPTZ DEFAULT now());
      INSERT INTO wallet_transactions (wallet_id, partner_id, transaction_type, direction, amount, balance_after, reference_type, reference_id)
      VALUES ('${WALLET_ID}', '${PARTNER_ID}', 'admin_adjustment', 'credit', 10, 710, 'admin', '00000000-0000-4000-8000-0000000000b1'),
             ('${WALLET_ID}', '${PARTNER_ID}', 'ADMIN_ADJUSTMENT', 'CREDIT', 20, 730, 'ADMIN', '00000000-0000-4000-8000-0000000000b2'),
             ('${WALLET_ID}', '${PARTNER_ID}', 'payout', 'debit', 5, 725, 'payout', '00000000-0000-4000-8000-0000000000b3');
    `);
    // pg-mem lacks window functions (COUNT(*) OVER()), so evaluate the repository's real
    // WHERE clause and parameters against the table directly.
    const matchingDirections = async (filters) => {
      let captured;
      const { setMockWalletResolver, resetMockWalletResolver } = require('../../src/repositories/admin-wallet.repository'); // eslint-disable-line global-require
      setMockWalletResolver(async (sql, params) => { captured = { sql, params }; return { rows: [] }; });
      try {
        await adminWalletRepository.listWalletTransactions(WALLET_ID, { page: 1, limit: 10, ...filters });
      } finally {
        resetMockWalletResolver();
      }
      const where = captured.sql.match(/WHERE([\s\S]*?)ORDER BY/i)[1];
      const usedParams = captured.params.slice(0, (where.match(/\$\d+/g) || []).length
        ? Math.max(...where.match(/\$\d+/g).map((p) => Number(p.slice(1)))) : 0);
      let bound = where;
      usedParams.forEach((value, i) => {
        bound = bound.replace(new RegExp(`\\$${i + 1}(?!\\d)`, 'g'), `'${value}'`);
      });
      return legacyDb.public.many(`SELECT wt.direction FROM wallet_transactions wt WHERE ${bound}`).map((r) => r.direction);
    };

    expect((await matchingDirections({ direction: 'CREDIT' })).sort()).toEqual(['CREDIT', 'credit']);
    expect((await matchingDirections({ transactionType: 'ADMIN_ADJUSTMENT' }))).toHaveLength(2);
    expect((await matchingDirections({ direction: 'debit' }))).toEqual(['debit']);
  });
});
