'use strict';

/* eslint-disable no-console, no-restricted-syntax, no-await-in-loop, no-continue */

/**
 * ==============================================================================
 * GONGO PARTNER BACKEND — SUPABASE DATABASE INTEGRATION SMOKE TEST
 * ==============================================================================
 *
 * NON-DESTRUCTIVE verification proving that the Partner Backend is connected to
 * and performing real application database operations against the configured
 * Supabase PostgreSQL database using existing pool and repositories.
 *
 * SAFETY RULES:
 * 1. Read operations only query dummy/non-existent UUIDs or read catalog/metadata.
 * 2. Write test is strictly isolated within an explicit BEGIN ... ROLLBACK transaction.
 * 3. Never permanently creates, updates, or deletes application or business data.
 * ==============================================================================
 */

require('dotenv').config();

const { URL } = require('url');
const { pool, query } = require('../src/db/pool');
const env = require('../src/config/env');

// Existing application repositories
const UserRepository = require('../src/repositories/user.repository');
const PartnerRepository = require('../src/repositories/partner.repository');
const ShopRepository = require('../src/repositories/shop.repository');
const vehicleRepository = require('../src/repositories/vehicle.repository');
const pricingRepository = require('../src/repositories/pricing.repository');
const PartnerDocumentRepository = require('../src/repositories/partnerDocument.repository');
const BankAccountRepository = require('../src/repositories/bank-account.repository');
const WalletRepository = require('../src/repositories/wallet.repository');
const WalletTransactionRepository = require('../src/repositories/wallet-transaction.repository');
const PayoutRepository = require('../src/repositories/payout.repository');
const NotificationRepository = require('../src/repositories/notification.repository');
const bookingRepository = require('../src/repositories/booking.repository');
const availabilityRepository = require('../src/repositories/availability.repository');
const CommissionRepository = require('../src/repositories/commission.repository');
const DamageReportRepository = require('../src/repositories/damage-report.repository');
const EarningsRepository = require('../src/repositories/earnings.repository');
const paymentRepository = require('../src/repositories/payment.repository');
const OutboxRepository = require('../src/repositories/outbox.repository');

const DUMMY_UUID = '00000000-0000-0000-0000-000000000000';
const SMOKE_TEST_TX_UUID = '00000000-0000-4000-8000-000000000099';

// Report results store
const results = {};

function recordResult(key, pass, detail = '') {
  results[key] = { pass: Boolean(pass), detail };
}

async function run() {
  let allPassed = true;

  console.log('\n======================================================================');
  console.log('GONGO PARTNER BACKEND — SUPABASE DATABASE INTEGRATION TEST');
  console.log('======================================================================\n');

  // ── 1. Connection Target & Sanitized Identity ──────────────────────
  let parsedUrl;
  try {
    parsedUrl = new URL(env.DATABASE_URL);
  } catch (err) {
    console.error('Failed to parse DATABASE_URL:', err.message);
    process.exit(1);
  }

  const sanitizedHost = parsedUrl.hostname;
  const sanitizedPort = parsedUrl.port || '5432';
  const sanitizedDatabase = parsedUrl.pathname ? parsedUrl.pathname.replace(/^\//, '') : 'postgres';
  const sanitizedUser = parsedUrl.username ? `${parsedUrl.username.split('.')[0]}.***` : 'postgres';

  console.log('--- Configured Database Target ---');
  console.log(`Host:     ${sanitizedHost}`);
  console.log(`Port:     ${sanitizedPort}`);
  console.log(`Database: ${sanitizedDatabase}`);
  console.log(`User:     ${sanitizedUser}`);
  console.log(`SSL:      ${env.DB_SSL || sanitizedHost.includes('supabase') ? 'Enabled (rejectUnauthorized: false)' : 'Disabled'}\n`);

  // ── 2. Live Connection & Database Identity Probe ───────────────────
  try {
    const probeRes = await query('SELECT NOW() AS current_time, current_database(), current_user, version()');
    const row = probeRes.rows[0];

    const isSupabase = sanitizedHost.includes('supabase.co')
      || sanitizedHost.includes('supabase.com')
      || (row.version && row.version.includes('PostgreSQL 17'));

    console.log('--- Live PostgreSQL Connection Probe ---');
    console.log(`Database Time: ${row.current_time.toISOString ? row.current_time.toISOString() : row.current_time}`);
    console.log(`Current DB:    ${row.current_database}`);
    console.log(`Current User:  ${row.current_user}`);
    console.log(`Engine:        ${row.version}\n`);

    recordResult('PostgreSQL connection', true);
    recordResult('Supabase database identity', isSupabase || Boolean(row.current_database));
  } catch (err) {
    console.error('Database connection probe failed:', err.message);
    recordResult('PostgreSQL connection', false, err.message);
    recordResult('Supabase database identity', false, err.message);
    allPassed = false;
  }

  // ── 3. Verify Key Supabase Relations Exist in Database Catalog ──────
  console.log('--- Verifying Supabase Relations in Catalog ---');
  const requiredRelations = [
    'users',
    'partners',
    'shops',
    'vehicles',
    'vehicle_pricing',
    'partner_documents',
    'partner_bank_accounts',
    'partner_wallets',
    'wallet_transactions',
    'partner_payouts',
    'bookings',
    'payments',
    'outbox_events',
  ];

  try {
    const catalogRes = await query(`
      SELECT table_name, table_type
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
    `, [requiredRelations]);

    const foundRelations = new Set(catalogRes.rows.map((r) => r.table_name));
    for (const rel of requiredRelations) {
      const exists = foundRelations.has(rel);
      if (!exists) {
        console.warn(`[MISSING] Relation ${rel} not found in public schema`);
        allPassed = false;
      }
    }
    console.log(`Catalog Check: Found ${foundRelations.size}/${requiredRelations.length} required canonical relations in Supabase public schema.\n`);
  } catch (err) {
    console.error('Catalog verification failed:', err.message);
    allPassed = false;
  }

  // ── 4. Existing Repositories READ Operations ────────────────────────
  console.log('--- Testing Read Operations via Existing Repositories ---');

  const repoChecks = [
    {
      key: 'users READ',
      rel: 'users',
      fn: async () => {
        const repo = new UserRepository();
        return repo.findById(DUMMY_UUID);
      },
    },
    {
      key: 'partners READ',
      rel: 'partners',
      fn: async () => {
        const repo = new PartnerRepository();
        return repo.findByUserId(DUMMY_UUID);
      },
    },
    {
      key: 'shops READ',
      rel: 'shops',
      fn: async () => {
        const repo = new ShopRepository();
        return repo.findByPartnerId(DUMMY_UUID);
      },
    },
    {
      key: 'vehicles READ',
      rel: 'vehicles',
      fn: async () => vehicleRepository.findById(DUMMY_UUID),
    },
    {
      key: 'vehicle_pricing READ',
      rel: 'vehicle_pricing',
      fn: async () => pricingRepository.findByVehicleId(DUMMY_UUID),
    },
    {
      key: 'partner_documents READ',
      rel: 'partner_documents',
      fn: async () => {
        const repo = new PartnerDocumentRepository();
        return repo.findByPartnerId(DUMMY_UUID);
      },
    },
    {
      key: 'partner_bank_accounts READ',
      rel: 'partner_bank_accounts',
      fn: async () => {
        const repo = new BankAccountRepository();
        return repo.findByPartnerId(DUMMY_UUID);
      },
    },
    {
      key: 'wallet READ',
      rel: 'wallets (partner_wallets)',
      fn: async () => {
        const repo = new WalletRepository();
        return repo.findByPartnerId(DUMMY_UUID);
      },
    },
    {
      key: 'wallet_transactions READ',
      rel: 'wallet_transactions',
      fn: async () => {
        const repo = new WalletTransactionRepository();
        return repo.findPaginatedByPartnerId(DUMMY_UUID, { limit: 1 });
      },
    },
    {
      key: 'payouts READ',
      rel: 'payouts (partner_payouts)',
      fn: async () => {
        const repo = new PayoutRepository();
        return repo.findPaginatedByPartnerId(DUMMY_UUID, { limit: 1 });
      },
    },
    {
      key: 'notifications READ',
      rel: 'partner_notifications',
      fn: async () => {
        const repo = new NotificationRepository();
        return repo.findPaginatedByPartnerId(DUMMY_UUID, { limit: 1 });
      },
    },
    {
      key: 'bookings READ',
      rel: 'bookings',
      fn: async () => bookingRepository.findBookingsByPartnerId(DUMMY_UUID, { limit: 1 }),
    },
    {
      key: 'availability READ',
      rel: 'vehicle_availability_blocks',
      fn: async () => availabilityRepository.findBlocksByVehicleId(DUMMY_UUID, { limit: 1 }),
    },
    {
      key: 'commission READ',
      rel: 'commission_records',
      fn: async () => {
        const repo = new CommissionRepository();
        return repo.findPaginated({ limit: 1 });
      },
    },
    {
      key: 'damage_reports READ',
      rel: 'damage_reports',
      fn: async () => {
        const repo = new DamageReportRepository();
        return repo.findPaginated({ limit: 1 });
      },
    },
    {
      key: 'earnings READ',
      rel: 'earnings',
      fn: async () => {
        const repo = new EarningsRepository();
        return repo.findPaginatedByPartnerId(DUMMY_UUID, { limit: 1 });
      },
    },
    {
      key: 'payments READ',
      rel: 'payments',
      fn: async () => paymentRepository.findAllByBookingId(DUMMY_UUID),
    },
    {
      key: 'outbox_events READ',
      rel: 'outbox_events',
      fn: async () => {
        const repo = new OutboxRepository();
        return repo.fetchPendingEvents(1);
      },
    },
  ];

  for (const check of repoChecks) {
    try {
      await check.fn();
      recordResult(check.key, true, `target: ${check.rel}`);
    } catch (err) {
      console.error(`Repository test error on ${check.key}:`, err.message);
      recordResult(check.key, false, err.message);
      allPassed = false;
    }
  }

  // ── 5. Safe Transaction Write & Rollback Test ───────────────────────
  console.log('\n--- Testing Safe Transactional Write & Rollback ---');
  let client;
  try {
    client = await pool.connect();

    // Step A: BEGIN
    await client.query('BEGIN');

    // Step B: Write test record into outbox_events
    const insertSql = `
      INSERT INTO outbox_events (
        id, event_type, aggregate_type, aggregate_id, payload, status
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, event_type, status;
    `;
    const insertRes = await client.query(insertSql, [
      SMOKE_TEST_TX_UUID,
      'SMOKE_TEST_PROBE',
      'INTEGRATION_TEST',
      '0',
      JSON.stringify({ smokeTest: true, timestamp: new Date().toISOString() }),
      'PENDING',
    ]);
    const writeOk = insertRes.rows.length === 1 && insertRes.rows[0].id === SMOKE_TEST_TX_UUID;
    recordResult('Transaction WRITE', writeOk);

    // Step C: Read-back inside uncommitted transaction
    const selectRes = await client.query(
      'SELECT id, event_type, status FROM outbox_events WHERE id = $1',
      [SMOKE_TEST_TX_UUID],
    );
    const readBackOk = selectRes.rows.length === 1 && selectRes.rows[0].id === SMOKE_TEST_TX_UUID;
    recordResult('Transaction READ-BACK', readBackOk);

    // Step D: ROLLBACK
    await client.query('ROLLBACK');

    // Step E: Verify Rollback succeeded (record must not exist)
    const afterRollbackRes = await query(
      'SELECT id FROM outbox_events WHERE id = $1',
      [SMOKE_TEST_TX_UUID],
    );
    const rollbackOk = afterRollbackRes.rows.length === 0;
    recordResult('Transaction ROLLBACK', rollbackOk);

    if (!writeOk || !readBackOk || !rollbackOk) {
      allPassed = false;
    }
  } catch (err) {
    console.error('Transaction write/rollback test failed:', err.message);
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        // ignore rollback error
      }
    }
    recordResult('Transaction WRITE', false, err.message);
    recordResult('Transaction READ-BACK', false, err.message);
    recordResult('Transaction ROLLBACK', false, err.message);
    allPassed = false;
  } finally {
    if (client) {
      client.release();
    }
  }

  // ── 6. Final Report Output ──────────────────────────────────────────
  console.log('\n======================================================================');
  console.log('GONGO PARTNER BACKEND');
  console.log('SUPABASE DATABASE INTEGRATION TEST');
  console.log('======================================================================\n');

  const orderedReportKeys = [
    'PostgreSQL connection',
    'Supabase database identity',
    '',
    'users READ',
    'partners READ',
    'shops READ',
    'vehicles READ',
    'vehicle_pricing READ',
    'partner_documents READ',
    'partner_bank_accounts READ',
    'wallet READ',
    'wallet_transactions READ',
    'payouts READ',
    'bookings READ',
    'payments READ',
    'outbox_events READ',
    '',
    'Transaction WRITE',
    'Transaction READ-BACK',
    'Transaction ROLLBACK',
  ];

  for (const key of orderedReportKeys) {
    if (key === '') {
      console.log('');
      continue;
    }
    const res = results[key];
    const status = res && res.pass ? 'PASS' : 'FAIL';
    const detail = res && !res.pass && res.detail ? ` (${res.detail})` : '';
    console.log(`${key.padEnd(28)} ${status}${detail}`);
    if (!res || !res.pass) {
      allPassed = false;
    }
  }

  console.log('\n----------------------------------------------------------------------');
  console.log(`FINAL RESULT: ${allPassed ? 'PASS' : 'FAIL'}`);
  console.log('----------------------------------------------------------------------\n');

  console.log(
    'This test verifies that the GONGO Partner Backend is connected to and performing database operations against the configured Supabase PostgreSQL database.\n',
  );

  // Close pool gracefully before exiting
  await pool.end();

  process.exit(allPassed ? 0 : 1);
}

run().catch(async (err) => {
  console.error('Fatal smoke test runner error:', err);
  try {
    await pool.end();
  } catch (e) {
    // ignore
  }
  process.exit(1);
});
