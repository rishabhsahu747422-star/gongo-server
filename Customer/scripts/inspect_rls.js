const { Client } = require('pg');
const fs = require('fs');

const connStr = 'postgresql://postgres.mtfljykvxyslhdvpfcil:Harshu%40898923@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres';

async function checkRLSandFunctions() {
  const client = new Client({
    connectionString: connStr,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();

  console.log('Checking RLS on tables...');
  const rlsRes = await client.query(`
    SELECT tablename, rowsecurity 
    FROM pg_tables 
    WHERE schemaname = 'public'
    ORDER BY tablename;
  `);

  console.log('Checking triggers...');
  const triggerRes = await client.query(`
    SELECT 
      event_object_table AS table_name,
      trigger_name,
      event_manipulation,
      action_timing,
      action_statement
    FROM information_schema.triggers
    WHERE trigger_schema = 'public'
    ORDER BY event_object_table, trigger_name;
  `);

  await client.end();

  console.log('RLS Status:');
  console.table(rlsRes.rows);

  console.log('Triggers:');
  console.table(triggerRes.rows.slice(0, 30));
  fs.writeFileSync('scripts/rls_triggers.json', JSON.stringify({ rls: rlsRes.rows, triggers: triggerRes.rows }, null, 2));
}

checkRLSandFunctions().catch(console.error);
