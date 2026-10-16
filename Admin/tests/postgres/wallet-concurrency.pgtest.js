'use strict';

/**
 * Real-PostgreSQL integration tests for Admin financial operations (row locking, concurrency,
 * rollback). pg-mem cannot verify these: it ignores ROLLBACK and has no row locks.
 *
 * Run ONLY against a disposable database (never production):
 *   TEST_PG_URL=postgresql://user:pass@localhost:5432/gongo_pgtest npm run test:pg
 *
 * Each run creates and drops its own schema; nothing outside it is touched. Without
 * TEST_PG_URL the file fails fast with an explanation (it is excluded from `npm test`).
 */

const crypto = require('crypto');
const { Pool } = require('pg');

const TEST_PG_URL = process.env.TEST_PG_URL;
if (!TEST_PG_URL) {
  throw new Error('TEST_PG_URL is not set — point it at a disposable PostgreSQL database to run test:pg');
}

const { setMockPool, resetMockPool } = require('../../src/db/pool');
const adminWalletService = require('../../src/services/admin-wallet.service');
const adminWalletRepository = require('../../src/repositories/admin-wallet.repository');
const auditService = require('../../src/services/audit.service');

const SCHEMA = `gongo_pgtest_${crypto.randomBytes(4).toString('hex')}`;
const PARTNER_ID = crypto.randomUUID();
const WALLET_ID = crypto.randomUUID();
const ADMIN_ID = crypto.randomUUID();
const ADMIN = { id: ADMIN_ID, role: 'admin', email: 'pgtest-admin@example.com' };

let adminPool;
let pool;

async function resetData(payoutStatus = 'pending') {
  await pool.query(`
    TRUNCATE wallet_transactions, partner_payouts, wallets, partner_wallets, users;
    INSERT INTO users VALUES ('${ADMIN_ID}', 'pgtest-admin@example.com', 'admin');
    INSERT INTO wallets VALUES ('${WALLET_ID}', '${PARTNER_ID}', 700, 0, 1000, 300, 'INR', now());
    INSERT INTO partner_wallets (id, partner_id, available_balance, total_paid_out, total_credited, total_debited)
      VALUES ('${WALLET_ID}', '${PARTNER_ID}', 700, 300, 1000, 300);
  `);
  const payoutId = crypto.randomUUID();
  await pool.query(
    'INSERT INTO partner_payouts (id, partner_id, amount, status) VALUES ($1, $2, 300, $3)',
    [payoutId, PARTNER_ID, payoutStatus],
  );
  return payoutId;
}

const balances = async () => {
  const w = await pool.query('SELECT available_balance FROM wallets WHERE partner_id = $1', [PARTNER_ID]);
  const m = await pool.query('SELECT available_balance FROM partner_wallets WHERE partner_id = $1', [PARTNER_ID]);
  return { wallets: Number(w.rows[0].available_balance), mirror: Number(m.rows[0].available_balance) };
};

beforeAll(async () => {
  adminPool = new Pool({ connectionString: TEST_PG_URL, max: 2 });
  await adminPool.query(`CREATE SCHEMA ${SCHEMA}`);
  pool = new Pool({ connectionString: TEST_PG_URL, max: 10, options: `-c search_path=${SCHEMA}` });
  await pool.query(`
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
      id BIGSERIAL PRIMARY KEY, wallet_id UUID NOT NULL, partner_id UUID NOT NULL,
      transaction_type VARCHAR(30) NOT NULL,
      direction VARCHAR(10) NOT NULL CHECK (direction IN ('credit', 'debit')),
      amount NUMERIC(12,2) NOT NULL CHECK (amount > 0), balance_before NUMERIC(12,2),
      balance_after NUMERIC(12,2) NOT NULL, reference_type VARCHAR(50) NOT NULL,
      reference_id UUID NOT NULL, status VARCHAR(30) NOT NULL DEFAULT 'COMPLETED',
      description TEXT, metadata JSONB, created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE partner_payouts (id UUID PRIMARY KEY, partner_id UUID, amount NUMERIC(12,2), status TEXT,
      failure_reason TEXT, notes TEXT, processed_by UUID, processed_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
      payment_reference TEXT, provider_transfer_id TEXT, payment_method TEXT, updated_at TIMESTAMPTZ);
  `);
  setMockPool(pool);
});

afterAll(async () => {
  resetMockPool();
  if (pool) await pool.end();
  if (adminPool) {
    await adminPool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await adminPool.end();
  }
});

beforeEach(() => {
  jest.spyOn(auditService, 'logAdminAction').mockResolvedValue(true);
});
afterEach(() => jest.restoreAllMocks());

describe('PostgreSQL: Admin wallet adjustment', () => {
  it('concurrent duplicate requests with one idempotency key apply exactly once', async () => {
    await resetData();
    const body = { amount: 50, direction: 'credit', reason: 'Goodwill', idempotencyKey: '11111111-0000-4000-8000-000000000001' };
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => adminWalletService.adjustWallet(WALLET_ID, { ...body }, ADMIN)),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const ledger = await pool.query("SELECT * FROM wallet_transactions WHERE reference_id = '11111111-0000-4000-8000-000000000001'");
    expect(ledger.rows).toHaveLength(1);
    expect(await balances()).toEqual({ wallets: 750, mirror: 750 });
    expect(results.filter((r) => r.value.idempotentReplay).length).toBe(4);
  });

  it('concurrent distinct adjustments serialize on the wallet row lock (no lost update)', async () => {
    await resetData();
    await Promise.all(Array.from({ length: 10 }, (_, i) => adminWalletService.adjustWallet(
      WALLET_ID,
      { amount: 10, direction: 'credit', reason: `Batch ${i}`, idempotencyKey: crypto.randomUUID() },
      ADMIN,
    )));
    expect(await balances()).toEqual({ wallets: 800, mirror: 800 });
    const ledger = await pool.query("SELECT count(*)::int AS n FROM wallet_transactions WHERE transaction_type = 'admin_adjustment'");
    expect(ledger.rows[0].n).toBe(10);
  });

  it('a failed ledger write rolls back the balance change for real', async () => {
    await resetData();
    jest.spyOn(adminWalletRepository, 'createWalletTransaction').mockRejectedValueOnce(new Error('ledger insert failed'));
    await expect(adminWalletService.adjustWallet(
      WALLET_ID,
      { amount: 50, direction: 'credit', reason: 'Fails', idempotencyKey: '11111111-0000-4000-8000-000000000002' },
      ADMIN,
    )).rejects.toThrow('ledger insert failed');
    expect(await balances()).toEqual({ wallets: 700, mirror: 700 });
  });

  it('the database rejects an invalid ledger direction', async () => {
    await resetData();
    await expect(pool.query(
      `INSERT INTO wallet_transactions (wallet_id, partner_id, transaction_type, direction, amount, balance_after, reference_type, reference_id)
       VALUES ($1, $2, 'payout', 'sideways', 1, 1, 'payout', 'bad')`,
      [WALLET_ID, PARTNER_ID],
    )).rejects.toThrow();
  });
});

describe('PostgreSQL: payout decisions', () => {
  it('racing mark-paid and reject on one payout: exactly one wins, balance consistent', async () => {
    const payoutId = await resetData();
    const results = await Promise.allSettled([
      adminWalletService.markPaid(payoutId, { utr: 'UTR-PG-1', paymentMethod: 'UPI' }, ADMIN),
      adminWalletService.rejectPayout(payoutId, { reason: 'Bank details invalid' }, ADMIN),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    const status = (await pool.query('SELECT status FROM partner_payouts WHERE id = $1', [payoutId])).rows[0].status;
    const bal = await balances();
    if (status === 'paid') expect(bal).toEqual({ wallets: 700, mirror: 700 });
    else expect(bal).toEqual({ wallets: 1000, mirror: 1000 });
    const ledger = await pool.query('SELECT count(*)::int AS n FROM wallet_transactions WHERE reference_id = $1', [payoutId]);
    expect(ledger.rows[0].n).toBe(1);
  });

  it('a repeated reject does not release the hold twice', async () => {
    const payoutId = await resetData();
    await adminWalletService.rejectPayout(payoutId, { reason: 'First' }, ADMIN);
    await expect(adminWalletService.rejectPayout(payoutId, { reason: 'Second' }, ADMIN))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(await balances()).toEqual({ wallets: 1000, mirror: 1000 });
  });
});
