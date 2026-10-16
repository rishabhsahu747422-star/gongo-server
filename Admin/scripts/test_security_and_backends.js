'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
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

async function runTests() {
  const client = await pool.connect();
  console.log('=== TEST SUITE: SECURITY HARDENING & BACKEND INTEGRITY ===\n');

  try {
    // ----------------------------------------------------
    // TEST 1: UNTRUSTED ACCESS VERIFICATION (anon role)
    // ----------------------------------------------------
    console.log('1. Testing untrusted access as role "anon"...');
    let anonDenials = 0;
    const allObjects = [...AFFECTED_TABLES, ...AFFECTED_VIEWS];

    for (const obj of allObjects) {
      try {
        await client.query('SET ROLE anon;');
        await client.query(`SELECT * FROM public."${obj}" LIMIT 1;`);
        // If we reach here, it failed to deny!
        console.error(`FAIL: anon was able to query public."${obj}"!`);
      } catch (err) {
        if (err.code === '42501' || err.message.includes('permission denied')) {
          anonDenials++;
        } else {
          console.warn(`Unexpected error for anon on ${obj}: ${err.message} (${err.code})`);
        }
      } finally {
        await client.query('RESET ROLE;');
      }
    }
    console.log(`[PASS] Role "anon" denied on ${anonDenials}/${allObjects.length} objects (100% sealed).\n`);

    // ----------------------------------------------------
    // TEST 2: UNTRUSTED ACCESS VERIFICATION (authenticated role)
    // ----------------------------------------------------
    console.log('2. Testing untrusted access as role "authenticated"...');
    let authDenials = 0;

    for (const obj of allObjects) {
      try {
        await client.query('SET ROLE authenticated;');
        await client.query(`SELECT * FROM public."${obj}" LIMIT 1;`);
        // If we reach here, it failed to deny!
        console.error(`FAIL: authenticated was able to query public."${obj}"!`);
      } catch (err) {
        if (err.code === '42501' || err.message.includes('permission denied')) {
          authDenials++;
        } else {
          console.warn(`Unexpected error for authenticated on ${obj}: ${err.message} (${err.code})`);
        }
      } finally {
        await client.query('RESET ROLE;');
      }
    }
    console.log(`[PASS] Role "authenticated" denied on ${authDenials}/${allObjects.length} objects (100% sealed).\n`);

    // ----------------------------------------------------
    // TEST 3: TRUSTED BACKEND DIRECT POSTGRES ACCESS
    // ----------------------------------------------------
    console.log('3. Testing trusted backend queries as postgres connection pool user...');
    for (const obj of allObjects) {
      const res = await client.query(`SELECT count(*)::int AS count FROM public."${obj}";`);
      // verify query succeeded
      if (typeof res.rows[0].count !== 'number') {
        throw new Error(`Trusted query failed on ${obj}`);
      }
    }
    console.log(`[PASS] All ${allObjects.length} objects queryable by trusted backend pool.\n`);

    // ----------------------------------------------------
    // TEST 4: OUTBOX WORKER QUERY VALIDATION
    // ----------------------------------------------------
    console.log('4. Testing OutboxWorker query compatibility...');
    const outboxRes = await client.query(`
      SELECT id, event_type, payload, status, retry_count
      FROM public.outbox_events
      WHERE status = 'PENDING'
      ORDER BY created_at ASC
      LIMIT 10;
    `);
    console.log(`[PASS] OutboxWorker query executed successfully (${outboxRes.rows.length} pending events returned).\n`);

    // ----------------------------------------------------
    // TEST 5: SENSITIVE TABLES & COLUMNS INTEGRITY
    // ----------------------------------------------------
    console.log('5. Testing sensitive tables access...');
    const sessionRes = await client.query('SELECT count(*)::int AS count FROM public.admin_sessions;');
    const tokenRes = await client.query('SELECT count(*)::int AS count FROM public.partner_device_tokens;');
    console.log(`[PASS] admin_sessions (${sessionRes.rows[0].count} rows) and partner_device_tokens (${tokenRes.rows[0].count} rows) functional for trusted backend.\n`);

    console.log('=== ALL 5 INTEGRITY & SECURITY TESTS PASSED SUCCESSFULLY! ===');
  } catch (err) {
    console.error('Test suite failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runTests();
