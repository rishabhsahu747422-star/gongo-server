'use strict';

/**
 * Partner wallet recalculation must agree with the ledger: Admin manual adjustments are
 * recorded only in wallet_transactions (transaction_type 'admin_adjustment'), so the
 * authoritative recalculation (settled earnings - held payouts) must include them or the
 * next wallet read silently erases them.
 *
 * pg-mem cannot parse `WITH ... UPDATE ... FROM`, so this test extracts the CTEs and the
 * exact SET expressions from the production SQL in wallet.service.js and evaluates them
 * with a SELECT. Any change to the production recalculation is exercised here.
 */

const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');

const PARTNER = 'partner-1';

function loadRecalculationSql() {
  const src = fs.readFileSync(path.join(__dirname, '../../src/services/wallet.service.js'), 'utf8');
  const syncSql = src.split('const syncSql = `')[1].split('`;')[0];
  const [ctes, updatePart] = syncSql.split(/\n\s*UPDATE wallets w/);
  const expr = (column, nextColumn) => {
    const match = updatePart.match(new RegExp(`${column} = ([\\s\\S]*?),\\n\\s*${nextColumn}`));
    if (!match) throw new Error(`Could not extract ${column} from recalculation SQL`);
    return match[1];
  };
  const fromMatch = updatePart.match(/FROM ([^\n]+)\n\s*WHERE w\.partner_id/);
  return `${ctes}
    SELECT
      ${expr('available_balance', 'pending_balance')} AS available_balance,
      ${expr('total_credited', 'total_debited')} AS total_credited,
      ${expr('total_debited', 'updated_at')} AS total_debited
    FROM ${fromMatch[1]}`;
}

function setupDb() {
  const db = newDb();
  db.public.none(`
    CREATE TABLE vehicles (id TEXT PRIMARY KEY, partner_id TEXT);
    CREATE TABLE bookings (id TEXT PRIMARY KEY, partner_id TEXT, vehicle_id TEXT,
      booking_status TEXT, status TEXT, total_amount NUMERIC(12,2));
    CREATE TABLE earnings (booking_id TEXT, partner_net_amount NUMERIC(12,2), commission_amount NUMERIC(12,2));
    CREATE TABLE commission_records (id SERIAL, booking_id TEXT, partner_payable_amount NUMERIC(12,2));
    CREATE TABLE commission_transactions (id SERIAL, booking_id TEXT, base_amount NUMERIC(12,2), commission_amount NUMERIC(12,2));
    CREATE TABLE partner_payouts (id TEXT, partner_id TEXT, amount NUMERIC(12,2), status TEXT);
    CREATE TABLE payouts (id TEXT, partner_id TEXT, amount NUMERIC(12,2), status TEXT);
    CREATE TABLE wallet_transactions (id SERIAL PRIMARY KEY, partner_id TEXT, transaction_type TEXT,
      direction TEXT, amount NUMERIC(12,2), status TEXT DEFAULT 'COMPLETED');

    INSERT INTO vehicles VALUES ('v-1', '${PARTNER}');
    -- One completed rental earning 1000 net to the partner
    INSERT INTO bookings VALUES ('b-1', '${PARTNER}', 'v-1', 'COMPLETED', 'completed', 1200);
    INSERT INTO earnings VALUES ('b-1', 1000, 200);
    -- A pending payout of 300 holds funds; a rejected one of 999 does not
    INSERT INTO partner_payouts VALUES ('po-1', '${PARTNER}', 300, 'pending');
    INSERT INTO partner_payouts VALUES ('po-2', '${PARTNER}', 999, 'rejected');
  `);
  return db;
}

function recalc(db) {
  const row = db.public.many(loadRecalculationSql().replace(/\$1/g, `'${PARTNER}'`))[0];
  return {
    available: Number(row.available_balance),
    credited: Number(row.total_credited),
    debited: Number(row.total_debited),
  };
}

describe('Partner wallet recalculation (production SQL) vs ledger', () => {
  it('without adjustments: available = settled earnings - held payouts (rejected payout released)', () => {
    expect(recalc(setupDb())).toEqual({ available: 700, credited: 1000, debited: 300 });
  });

  it('includes COMPLETED admin_adjustment ledger rows in stored and legacy casing only', () => {
    const db = setupDb();
    db.public.none(`
      INSERT INTO wallet_transactions (partner_id, transaction_type, direction, amount, status) VALUES
        ('${PARTNER}', 'admin_adjustment', 'credit', 150, 'COMPLETED'),
        ('${PARTNER}', 'ADMIN_ADJUSTMENT', 'DEBIT', 50, 'COMPLETED'),
        ('${PARTNER}', 'admin_adjustment', 'credit', 999, 'FAILED'),
        ('${PARTNER}', 'payout', 'debit', 300, 'COMPLETED'),
        ('other-partner', 'admin_adjustment', 'credit', 5000, 'COMPLETED')
    `);
    // 1000 settled - 300 held + 150 - 50. FAILED rows, payout ledger rows (already counted
    // via partner_payouts) and other partners' rows are excluded.
    expect(recalc(db)).toEqual({ available: 800, credited: 1150, debited: 350 });
  });

  it('never drives available balance negative', () => {
    const db = setupDb();
    db.public.none(`
      INSERT INTO wallet_transactions (partner_id, transaction_type, direction, amount, status)
      VALUES ('${PARTNER}', 'admin_adjustment', 'debit', 5000, 'COMPLETED')
    `);
    expect(recalc(db).available).toBe(0);
  });
});
