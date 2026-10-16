const { Client } = require('pg');

const connStr = 'postgresql://postgres.mtfljykvxyslhdvpfcil:Harshu%40898923@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres';

async function run() {
  const c = new Client({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  await c.connect();

  console.log('--- Constraints on public.users ---');
  const fks = await c.query(`
    SELECT tc.constraint_name, tc.constraint_type, kcu.column_name
    FROM information_schema.table_constraints tc 
    JOIN information_schema.key_column_usage kcu 
      ON tc.constraint_name = kcu.constraint_name 
      AND tc.table_schema = kcu.table_schema
    WHERE tc.table_name = 'users' AND tc.table_schema = 'public'
  `);
  console.table(fks.rows);

  console.log('--- Triggers on public.users ---');
  const trgs = await c.query("SELECT trigger_name, action_timing, event_manipulation, action_statement FROM information_schema.triggers WHERE event_object_table = 'users'");
  console.table(trgs.rows);

  console.log('--- Customer users in public.users ---');
  const sample = await c.query("SELECT id, phone, role, status, auth_id, auth_provider, name, email FROM public.users WHERE role ILIKE 'customer' LIMIT 10");
  console.table(sample.rows);

  console.log('--- Customer profiles ---');
  const profiles = await c.query("SELECT * FROM public.customer_profiles LIMIT 10");
  console.table(profiles.rows);

  await c.end();
}

run().catch(console.error);
