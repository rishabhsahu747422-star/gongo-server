'use strict';
const { query } = require('../src/db/pool');

async function main() {
  const tables = ['wallets', 'partner_wallets', 'payouts', 'partner_payouts', 'wallet_transactions', 'partner_bank_accounts', 'partners'];
  for (const tbl of tables) {
    try {
      const cols = await query(
        `SELECT column_name, data_type, is_nullable, column_default 
         FROM information_schema.columns 
         WHERE table_name = $1 
         ORDER BY ordinal_position`,
        [tbl]
      );
      const cnt = await query(`SELECT count(*)::int as count FROM ${tbl}`);
      console.log(`\n================ ${tbl} (rows: ${cnt.rows[0].count}) ================`);
      cols.rows.forEach(c => console.log(`  ${c.column_name}: ${c.data_type} (nullable: ${c.is_nullable}, default: ${c.column_default})`));

      const samples = await query(`SELECT * FROM ${tbl} LIMIT 2`);
      console.log('Sample rows:', JSON.stringify(samples.rows, null, 2));
    } catch (e) {
      console.error(`Error on ${tbl}:`, e.message);
    }
  }

  // Also check triggers or constraints on wallets and payouts
  const constraints = await query(
    `SELECT conname, conrelid::regclass as tbl, contype, pg_get_constraintdef(oid) as def
     FROM pg_constraint
     WHERE conrelid IN ('wallets'::regclass, 'partner_wallets'::regclass, 'payouts'::regclass, 'partner_payouts'::regclass, 'wallet_transactions'::regclass)`
  );
  console.log('\n================ CONSTRAINTS ================');
  constraints.rows.forEach(c => console.log(`${c.tbl} -> ${c.conname} (${c.contype}): ${c.def}`));

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
