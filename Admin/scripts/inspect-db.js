'use strict';
const { Client } = require('pg');

async function main() {
  const client = new Client({
    connectionString: 'postgresql://postgres.mtfljykvxyslhdvpfcil:Harshu%40898923@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres'
  });
  await client.connect();

  for (const t of ['partner_verification_history', 'admin_actions']) {
    const cols = await client.query(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_name = $1`,
      [t]
    );
    console.log(`\n=== TABLE: ${t} ===`, cols.rows);
  }

  const constraints = await client.query(
    `SELECT conname, contype, pg_get_constraintdef(oid) as def
     FROM pg_constraint
     WHERE conrelid IN ('partners'::regclass, 'shops'::regclass, 'vehicles'::regclass, 'bookings'::regclass)`
  );
  console.log('\n=== CONSTRAINTS ===');
  constraints.rows.forEach(c => console.log(`${c.conname} (${c.contype}): ${c.def}`));

  const partnerCheck = await client.query('SELECT id, business_name, status, partner_status, kyc_status, is_active FROM partners LIMIT 10');
  console.log('\n=== SAMPLE PARTNERS ===', partnerCheck.rows);

  await client.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
