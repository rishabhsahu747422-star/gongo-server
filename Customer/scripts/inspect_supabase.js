const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const connStr = 'postgresql://postgres.mtfljykvxyslhdvpfcil:Harshu%40898923@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres';

async function inspect() {
  const client = new Client({
    connectionString: connStr,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();

  console.log('Fetching columns...');
  const colsRes = await client.query(`
    SELECT 
      table_name, 
      column_name, 
      ordinal_position,
      column_default, 
      is_nullable, 
      data_type, 
      udt_name,
      character_maximum_length
    FROM information_schema.columns 
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position;
  `);

  console.log('Fetching primary and unique keys...');
  const pkRes = await client.query(`
    SELECT
      tc.table_name, 
      tc.constraint_name, 
      tc.constraint_type,
      kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    WHERE tc.table_schema = 'public' 
      AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
    ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position;
  `);

  console.log('Fetching foreign keys...');
  const fkRes = await client.query(`
    SELECT
      tc.table_name, 
      kcu.column_name, 
      ccu.table_schema AS foreign_table_schema,
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name,
      rc.delete_rule,
      rc.update_rule
    FROM information_schema.table_constraints AS tc 
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.referential_constraints AS rc
      ON tc.constraint_name = rc.constraint_name
    JOIN information_schema.constraint_column_usage AS ccu
      ON rc.unique_constraint_name = ccu.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema='public'
    ORDER BY tc.table_name, kcu.column_name;
  `);

  console.log('Fetching enums...');
  const enumRes = await client.query(`
    SELECT 
      t.typname AS enum_name,
      e.enumlabel AS enum_value,
      e.enumsortorder AS sort_order
    FROM pg_type t 
    JOIN pg_enum e ON t.oid = e.enumtypid  
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    ORDER BY t.typname, e.enumsortorder;
  `);

  console.log('Fetching check constraints...');
  const checkRes = await client.query(`
    SELECT
      tc.table_name,
      tc.constraint_name,
      cc.check_clause
    FROM information_schema.table_constraints tc
    JOIN information_schema.check_constraints cc
      ON tc.constraint_name = cc.constraint_name
    WHERE tc.table_schema = 'public' AND tc.constraint_type = 'CHECK'
    ORDER BY tc.table_name, tc.constraint_name;
  `);

  console.log('Fetching storage buckets...');
  let buckets = [];
  try {
    const bRes = await client.query('SELECT id, name, public, file_size_limit, allowed_mime_types FROM storage.buckets');
    buckets = bRes.rows;
  } catch (e) {
    console.warn('Could not query storage.buckets:', e.message);
  }

  console.log('Fetching auth.users columns...');
  const authCols = await client.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'auth' AND table_name = 'users'
    ORDER BY ordinal_position;
  `);

  await client.end();

  const schemaData = {
    columns: colsRes.rows,
    primaryAndUniqueKeys: pkRes.rows,
    foreignKeys: fkRes.rows,
    enums: enumRes.rows,
    checks: checkRes.rows,
    storageBuckets: buckets,
    authUsersColumns: authCols.rows
  };

  const outPath = path.join(__dirname, 'supabase_schema.json');
  fs.writeFileSync(outPath, JSON.stringify(schemaData, null, 2));
  console.log('Saved schema to', outPath);
}

inspect().catch(err => {
  console.error('Inspect failed:', err);
  process.exit(1);
});
