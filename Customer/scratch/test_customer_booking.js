require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function main() {
  try {
    const cols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'partner_wallets'");
    console.log('partner_wallets columns:', cols.rows.map(r => r.column_name));
    const cons = await pool.query("SELECT conname, contype FROM pg_constraint WHERE conrelid = 'partner_wallets'::regclass");
    console.log('partner_wallets constraints:', cons.rows);
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

main();
