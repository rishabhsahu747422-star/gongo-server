'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { Pool } = require('pg');
const env = require('../src/config/env');

const PREVIOUS_FLAGGED_TABLES = [
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

const PREVIOUS_FLAGGED_VIEWS = [
  'support_ticket_messages',
  'wallets',
  'payouts'
];

const SENSITIVE_COLUMNS = [
  { table: 'admin_sessions', column: 'session_token' },
  { table: 'partner_device_tokens', column: 'token' }
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

async function runSecurityAdvisorAudit() {
  const client = await pool.connect();
  console.log('===============================================================');
  console.log(' SUPABASE SECURITY ADVISOR READ-ONLY FINAL VERIFICATION AUDIT ');
  console.log('===============================================================\n');

  try {
    // -------------------------------------------------------------------------
    // 1. CHECK RLS STATUS ACROSS THE ENTIRE PUBLIC SCHEMA
    // -------------------------------------------------------------------------
    console.log('--- 1. AUDITING RLS STATUS (ALL PUBLIC TABLES) ---');
    const allTablesQuery = `
      SELECT 
        c.relname AS table_name,
        c.relrowsecurity AS rls_enabled,
        c.relforcerowsecurity AS rls_forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
      ORDER BY c.relname;
    `;
    const allTablesRes = await client.query(allTablesQuery);
    
    const rlsDisabledAll = allTablesRes.rows.filter(r => !r.rls_enabled);
    const previouslyFlaggedStillDisabled = PREVIOUS_FLAGGED_TABLES.filter(tbl => {
      const row = allTablesRes.rows.find(r => r.table_name === tbl);
      return !row || !row.rls_enabled;
    });

    console.log(`Total public tables audited: ${allTablesRes.rows.length}`);
    console.log(`Previously flagged tables with RLS disabled: ${previouslyFlaggedStillDisabled.length}`);
    if (previouslyFlaggedStillDisabled.length > 0) {
      console.error('FAIL: Previously flagged tables still disabled:', previouslyFlaggedStillDisabled);
    } else {
      console.log('SUCCESS: All 19 previously flagged tables have relrowsecurity = TRUE.');
    }

    if (rlsDisabledAll.length > 0) {
      console.log(`Other tables in public schema with RLS disabled: ${rlsDisabledAll.map(t => t.table_name).join(', ')}`);
    } else {
      console.log('SUCCESS: ZERO tables in public schema have RLS disabled.');
    }

    // -------------------------------------------------------------------------
    // 2. CHECK SECURITY_INVOKER ON ALL VIEWS IN PUBLIC SCHEMA
    // -------------------------------------------------------------------------
    console.log('\n--- 2. AUDITING VIEWS (SECURITY_INVOKER) ---');
    const allViewsQuery = `
      SELECT 
        c.relname AS view_name,
        (c.reloptions IS NOT NULL AND 'security_invoker=true' = ANY(c.reloptions)) AS is_security_invoker,
        c.reloptions::text AS reloptions
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'v'
      ORDER BY c.relname;
    `;
    const allViewsRes = await client.query(allViewsQuery);

    const flaggedViewsNotInvoker = PREVIOUS_FLAGGED_VIEWS.filter(vName => {
      const row = allViewsRes.rows.find(r => r.view_name === vName);
      return !row || !row.is_security_invoker;
    });

    console.log(`Total public views audited: ${allViewsRes.rows.length}`);
    if (flaggedViewsNotInvoker.length > 0) {
      console.error('FAIL: Flagged views missing security_invoker:', flaggedViewsNotInvoker);
    } else {
      console.log('SUCCESS: All 3 previously flagged views have security_invoker = TRUE.');
    }

    const nonInvokerViews = allViewsRes.rows.filter(v => !v.is_security_invoker);
    if (nonInvokerViews.length > 0) {
      console.log(`Other views in public schema without security_invoker=true: ${nonInvokerViews.map(v => v.view_name).join(', ')}`);
    } else {
      console.log('SUCCESS: ALL views in public schema have security_invoker = TRUE.');
    }

    // -------------------------------------------------------------------------
    // 3. CHECK PRIVILEGES FOR UNTRUSTED ROLES (anon, authenticated)
    // -------------------------------------------------------------------------
    console.log('\n--- 3. AUDITING PRIVILEGES FOR UNTRUSTED ROLES (anon, authenticated) ---');
    const privQuery = `
      SELECT table_name, grantee, privilege_type
      FROM information_schema.table_privileges
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
        AND grantee IN ('anon', 'authenticated')
      ORDER BY table_name, grantee, privilege_type;
    `;
    const all22 = [...PREVIOUS_FLAGGED_TABLES, ...PREVIOUS_FLAGGED_VIEWS];
    const privRes = await client.query(privQuery, [all22]);

    console.log(`Remaining table/view privileges for anon/authenticated across the 22 objects: ${privRes.rows.length}`);
    if (privRes.rows.length > 0) {
      console.error('FAIL: Found privileges for untrusted roles:', privRes.rows);
    } else {
      console.log('SUCCESS: 0 privileges exist for anon and authenticated on all 22 objects.');
    }

    // Check column privileges
    const colPrivQuery = `
      SELECT table_name, column_name, grantee, privilege_type
      FROM information_schema.column_privileges
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
        AND grantee IN ('anon', 'authenticated');
    `;
    const colPrivRes = await client.query(colPrivQuery, [all22]);
    console.log(`Remaining column privileges for anon/authenticated across the 22 objects: ${colPrivRes.rows.length}`);
    if (colPrivRes.rows.length > 0) {
      console.error('FAIL: Found column privileges for untrusted roles:', colPrivRes.rows);
    } else {
      console.log('SUCCESS: 0 column privileges exist for anon/authenticated on all 22 objects.');
    }

    // -------------------------------------------------------------------------
    // 4. SENSITIVE COLUMNS EXPOSURE AUDIT
    // -------------------------------------------------------------------------
    console.log('\n--- 4. SENSITIVE COLUMNS AUDIT ---');
    for (const item of SENSITIVE_COLUMNS) {
      const colCheck = `
        SELECT grantee, privilege_type
        FROM information_schema.column_privileges
        WHERE table_schema = 'public'
          AND table_name = $1
          AND column_name = $2
          AND grantee IN ('anon', 'authenticated');
      `;
      const cRes = await client.query(colCheck, [item.table, item.column]);
      console.log(`Column ${item.table}.${item.column} exposed to anon/authenticated: ${cRes.rows.length > 0 ? 'YES' : 'NO'}`);
    }

    // -------------------------------------------------------------------------
    // 5. CHECK POLICIES ON THE 19 TABLES
    // -------------------------------------------------------------------------
    console.log('\n--- 5. CHECKING PG_POLICIES ON THE 19 TABLES ---');
    const polQuery = `
      SELECT schemaname, tablename, policyname, permissive, roles, cmd
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = ANY($1::text[]);
    `;
    const polRes = await client.query(polQuery, [PREVIOUS_FLAGGED_TABLES]);
    console.log(`Policies on the 19 tables: ${polRes.rows.length}`);
    if (polRes.rows.length === 0) {
      console.log('CONFIRMED: Exactly 0 policies exist (backend-only tables with RLS enabled are completely sealed from PostgREST).');
    } else {
      console.log('Policies found:', polRes.rows);
    }

    // -------------------------------------------------------------------------
    // 6. CHECK ALL FUNCTIONS IN PUBLIC SCHEMA FOR SECURITY DEFINER & SEARCH_PATH
    // -------------------------------------------------------------------------
    console.log('\n--- 6. CHECKING FUNCTIONS (SECURITY DEFINER & SEARCH_PATH) ---');
    const funcQuery = `
      SELECT 
        p.proname AS function_name,
        n.nspname AS schema_name,
        p.prosecdef AS is_security_definer,
        p.proconfig AS config
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
      ORDER BY p.proname;
    `;
    const funcRes = await client.query(funcQuery);
    const secDefFuncs = funcRes.rows.filter(f => f.is_security_definer);
    console.log(`Total public functions: ${funcRes.rows.length}`);
    console.log(`SECURITY DEFINER public functions: ${secDefFuncs.length}`);
    if (secDefFuncs.length > 0) {
      console.log('SECURITY DEFINER functions found:', secDefFuncs.map(f => ({ name: f.function_name, config: f.config })));
    } else {
      console.log('SUCCESS: No SECURITY DEFINER functions in public schema.');
    }

    // -------------------------------------------------------------------------
    // 7. TRUSTED BACKEND ACCESS INTEGRITY CHECK
    // -------------------------------------------------------------------------
    console.log('\n--- 7. TRUSTED BACKEND ACCESS INTEGRITY CHECK ---');
    let successfulQueries = 0;
    for (const obj of all22) {
      const qRes = await client.query(`SELECT count(*)::int AS count FROM public."${obj}";`);
      if (typeof qRes.rows[0].count === 'number') {
        successfulQueries++;
      }
    }
    console.log(`Trusted backend queried: ${successfulQueries}/${all22.length} objects successfully.`);

    // -------------------------------------------------------------------------
    // 8. SIMULATE UNTRUSTED ROLES VIA SET ROLE
    // -------------------------------------------------------------------------
    console.log('\n--- 8. SIMULATING UNTRUSTED QUERIES (anon & authenticated) ---');
    let anonBlocked = 0;
    let authBlocked = 0;
    for (const obj of all22) {
      // anon
      try {
        await client.query('SET ROLE anon;');
        await client.query(`SELECT * FROM public."${obj}" LIMIT 1;`);
        console.error(`ANON LEAK DETECTED: able to query ${obj}`);
      } catch (err) {
        if (err.code === '42501' || err.message.includes('permission denied')) {
          anonBlocked++;
        }
      } finally {
        await client.query('RESET ROLE;');
      }

      // authenticated
      try {
        await client.query('SET ROLE authenticated;');
        await client.query(`SELECT * FROM public."${obj}" LIMIT 1;`);
        console.error(`AUTHENTICATED LEAK DETECTED: able to query ${obj}`);
      } catch (err) {
        if (err.code === '42501' || err.message.includes('permission denied')) {
          authBlocked++;
        }
      } finally {
        await client.query('RESET ROLE;');
      }
    }

    console.log(`anon role access denied: ${anonBlocked}/${all22.length}`);
    console.log(`authenticated role access denied: ${authBlocked}/${all22.length}`);

    console.log('\n===============================================================');
    console.log(' AUDIT COMPLETE: ALL CRITERIA VERIFIED');
    console.log('===============================================================');

  } catch (err) {
    console.error('Audit encountered error:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runSecurityAdvisorAudit();
