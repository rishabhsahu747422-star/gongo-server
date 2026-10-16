'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const env = require('../src/config/env');

const AFFECTED_TABLES = [
  'storage_uploads',
  'payment_events',
  'earnings',
  'schema_migrations',
  'booking_pickup_verifications',
  'vehicle_availability_blocks',
  'partner_notifications',
  'partner_device_tokens',
  'booking_pricing_snapshots',
  'commission_records',
  'damage_reports',
  'admin_settings',
  'admin_permissions',
  'admin_sessions',
  'outbox_events',
  'vehicle_pricing_history',
  'booking_return_verifications',
  'pgmigrations',
  'idempotency_keys'
];

const AFFECTED_VIEWS = [
  'support_ticket_messages',
  'wallets',
  'payouts'
];

let sslConfig = false;
if (env.DB_SSL || (env.DATABASE_URL && (env.DATABASE_URL.includes('supabase.co') || env.DATABASE_URL.includes('supabase.com') || env.DATABASE_URL.includes('pooler.supabase.com')))) {
  sslConfig = { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: sslConfig,
  connectionTimeoutMillis: 15000,
});

async function captureSnapshot(client) {
  console.log('Capturing exact BEFORE-STATE security snapshot...');

  // 1. Table RLS and ACL state
  const tableStateQuery = `
    SELECT 
      c.relname AS table_name,
      c.relrowsecurity AS rls_enabled,
      c.relforcerowsecurity AS rls_forced,
      c.relacl::text AS acl,
      pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname = ANY($1::text[])
    ORDER BY c.relname;
  `;
  const tableStateRes = await client.query(tableStateQuery, [AFFECTED_TABLES]);

  // 2. Existing policies
  const policyQuery = `
    SELECT 
      schemaname,
      tablename,
      policyname,
      permissive,
      roles,
      cmd,
      qual,
      with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = ANY($1::text[])
    ORDER BY tablename, policyname;
  `;
  const policyRes = await client.query(policyQuery, [AFFECTED_TABLES]);

  // 3. Information schema privileges
  const privilegesQuery = `
    SELECT 
      table_name,
      grantee,
      privilege_type,
      is_grantable
    FROM information_schema.table_privileges
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
      AND grantee IN ('anon', 'authenticated', 'service_role', 'postgres')
    ORDER BY table_name, grantee, privilege_type;
  `;
  const allObjects = [...AFFECTED_TABLES, ...AFFECTED_VIEWS];
  const privilegesRes = await client.query(privilegesQuery, [allObjects]);

  // 4. View definitions and settings
  const viewStateQuery = `
    SELECT 
      c.relname AS view_name,
      pg_get_userbyid(c.relowner) AS owner,
      (c.reloptions IS NOT NULL AND 'security_invoker=true' = ANY(c.reloptions)) AS is_security_invoker,
      c.reloptions::text AS reloptions,
      c.relacl::text AS acl,
      pg_get_viewdef(c.oid, true) AS view_definition
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'v'
      AND c.relname = ANY($1::text[])
    ORDER BY c.relname;
  `;
  const viewStateRes = await client.query(viewStateQuery, [AFFECTED_VIEWS]);

  // 5. Data row counts (to verify no data loss)
  const rowCounts = {};
  for (const tbl of AFFECTED_TABLES) {
    try {
      const countRes = await client.query(`SELECT count(*)::int AS count FROM public."${tbl}"`);
      rowCounts[tbl] = countRes.rows[0].count;
    } catch (err) {
      rowCounts[tbl] = `ERROR: ${err.message}`;
    }
  }

  const snapshot = {
    timestamp: new Date().toISOString(),
    database_url_host: env.DB_HOST || 'supabase',
    affected_tables: AFFECTED_TABLES,
    affected_views: AFFECTED_VIEWS,
    table_rls_and_acl: tableStateRes.rows,
    existing_policies: policyRes.rows,
    privileges: privilegesRes.rows,
    view_definitions: viewStateRes.rows,
    row_counts_before: rowCounts,
  };

  const outputDir = path.resolve(__dirname, '../../../zmdfiles');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const jsonFilePath = path.join(outputDir, 'security_hardening_before_snapshot.json');
  fs.writeFileSync(jsonFilePath, JSON.stringify(snapshot, null, 2), 'utf8');
  console.log(`Snapshot saved successfully to: ${jsonFilePath}`);

  return snapshot;
}

async function run() {
  const mode = process.argv[2] || 'snapshot';
  const client = await pool.connect();

  try {
    if (mode === 'snapshot') {
      const snapshot = await captureSnapshot(client);
      console.log('Snapshot summary:');
      console.log(`- Tables captured: ${snapshot.table_rls_and_acl.length}`);
      console.log(`- Views captured: ${snapshot.view_definitions.length}`);
      console.log(`- Existing policies captured: ${snapshot.existing_policies.length}`);
      console.log(`- Privileges captured: ${snapshot.privileges.length}`);
    } else if (mode === 'migrate') {
      console.log('Beginning transactional security hardening migration...');
      await client.query('BEGIN');

      // 1. Views: security_invoker = true and revoke anon, authenticated
      console.log('Hardening views...');
      for (const view of AFFECTED_VIEWS) {
        await client.query(`ALTER VIEW public."${view}" SET (security_invoker = true);`);
        await client.query(`REVOKE ALL ON TABLE public."${view}" FROM anon, authenticated;`);
      }

      // 2. Tables: Enable RLS and revoke anon, authenticated
      console.log('Hardening tables...');
      for (const tbl of AFFECTED_TABLES) {
        await client.query(`ALTER TABLE public."${tbl}" ENABLE ROW LEVEL SECURITY;`);
        await client.query(`REVOKE ALL ON TABLE public."${tbl}" FROM anon, authenticated;`);
      }

      await client.query('COMMIT');
      console.log('Transactional security hardening migration COMMITTED successfully.');
    } else if (mode === 'verify') {
      console.log('Verifying post-migration state...');
      
      // Tables check
      const tblCheck = await client.query(`
        SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1::text[])
        ORDER BY c.relname;
      `, [AFFECTED_TABLES]);

      console.log('Table RLS status:');
      const rlsFailures = [];
      for (const r of tblCheck.rows) {
        if (!r.relrowsecurity) {
          rlsFailures.push(r.relname);
        }
      }
      if (rlsFailures.length > 0) {
        throw new Error(`RLS not enabled on tables: ${rlsFailures.join(', ')}`);
      }
      console.log(`All ${tblCheck.rows.length} tables have relrowsecurity = true.`);

      // Views check
      const viewCheck = await client.query(`
        SELECT c.relname,
               (c.reloptions IS NOT NULL AND 'security_invoker=true' = ANY(c.reloptions)) AS is_security_invoker
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'v' AND c.relname = ANY($1::text[])
        ORDER BY c.relname;
      `, [AFFECTED_VIEWS]);

      console.log('View security_invoker status:');
      const viewFailures = [];
      for (const v of viewCheck.rows) {
        if (!v.is_security_invoker) {
          viewFailures.push(v.relname);
        }
      }
      if (viewFailures.length > 0) {
        throw new Error(`security_invoker not enabled on views: ${viewFailures.join(', ')}`);
      }
      console.log(`All ${viewCheck.rows.length} views have security_invoker = true.`);

      // Privileges check: anon and authenticated should have 0 privileges
      const privCheck = await client.query(`
        SELECT table_name, grantee, privilege_type
        FROM information_schema.table_privileges
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
          AND grantee IN ('anon', 'authenticated');
      `, [[...AFFECTED_TABLES, ...AFFECTED_VIEWS]]);

      if (privCheck.rows.length > 0) {
        console.warn('WARNING: Remaining privileges found for anon/authenticated:', privCheck.rows);
        throw new Error(`Found ${privCheck.rows.length} remaining privileges for anon/authenticated`);
      }
      console.log('Zero privileges confirmed for anon and authenticated across all 22 objects.');

      // Row counts check: verify no data lost
      const beforeSnapshotPath = path.resolve(__dirname, '../../../zmdfiles/security_hardening_before_snapshot.json');
      if (fs.existsSync(beforeSnapshotPath)) {
        const snap = JSON.parse(fs.readFileSync(beforeSnapshotPath, 'utf8'));
        console.log('Verifying data row counts against before-snapshot...');
        for (const tbl of AFFECTED_TABLES) {
          const countRes = await client.query(`SELECT count(*)::int AS count FROM public."${tbl}"`);
          const currentCount = countRes.rows[0].count;
          const beforeCount = snap.row_counts_before[tbl];
          if (typeof beforeCount === 'number' && currentCount !== beforeCount) {
            throw new Error(`Row count mismatch on ${tbl}: before=${beforeCount}, current=${currentCount}`);
          }
        }
        console.log('Data row counts verified identical to before-snapshot. Zero data loss.');
      }
    }
  } catch (err) {
    console.error('ERROR in security hardening manager:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
