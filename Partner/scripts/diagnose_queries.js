'use strict';
require('dotenv').config();
const { pool } = require('../src/db/pool');

async function runExplain(label, query, params) {
  console.log(`\n==================================================`);
  console.log(`DIAGNOSING: ${label}`);
  console.log(`SQL: ${query.trim()}`);
  console.log(`Params:`, params);
  const t0 = Date.now();
  try {
    const explainRes = await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${query}`, params);
    const dbDuration = Date.now() - t0;
    console.log(`Round-trip Time: ${dbDuration}ms`);
    console.log('EXPLAIN PLAN:');
    explainRes.rows.forEach(r => console.log('  ' + r['QUERY PLAN']));

    // Also run query directly to see row count and execution
    const dataRes = await pool.query(query, params);
    console.log(`Actual Rows Returned: ${dataRes.rows.length}`);
    if (dataRes.rows.length > 0) {
      console.log(`Sample Row keys:`, Object.keys(dataRes.rows[0]));
    }
  } catch (err) {
    console.error(`Error explaining ${label}:`, err.message);
  }
}

async function main() {
  const partnerId = 'dc3a5acd-8d03-45c0-8cb9-23d1b3ffd562';
  const authId = 'dev-partner-auth-id';

  // 1. Auth Lookup
  await runExplain(
    'Auth Lookup (findByAuthId)',
    `SELECT 
      p.id AS id, p.id AS partner_id, p.user_id, p.partner_status, p.kyc_status,
      u.id AS user_primary_id, u.auth_id, u.role, u.name, u.phone, u.email
    FROM users u
    LEFT JOIN partners p ON p.user_id = u.id
    WHERE u.auth_id = $1
    LIMIT 1`,
    [authId]
  );

  // 2. Partner findById
  await runExplain(
    'Partner findById',
    `SELECT * FROM partners WHERE id = $1 LIMIT 1`,
    [partnerId]
  );

  // 3. Vehicles List
  await runExplain(
    'Vehicles List (with correlated cover_image_key subquery)',
    `SELECT 
      v.id, v.partner_id, v.category, v.brand, v.model, v.registration_number,
      vp.price_per_hour, vp.price_per_day,
      (
        SELECT storage_key 
        FROM vehicle_images vi 
        WHERE vi.vehicle_id = v.id AND vi.is_active = true 
        ORDER BY vi.is_cover DESC, vi.sort_order ASC, vi.created_at ASC 
        LIMIT 1
      ) AS cover_image_key
    FROM vehicles v
    LEFT JOIN vehicle_pricing vp ON vp.vehicle_id = v.id
    WHERE v.partner_id = $1 AND v.is_archived = false
    ORDER BY v.created_at DESC
    LIMIT 100 OFFSET 0`,
    [partnerId]
  );

  // 4. Vehicles Count
  await runExplain(
    'Vehicles Count',
    `SELECT COUNT(*)::int AS total FROM vehicles v WHERE v.partner_id = $1 AND v.is_archived = false`,
    [partnerId]
  );

  // 5. Bookings List
  await runExplain(
    'Bookings List (with correlated cover_image_key subquery and 4 joins)',
    `SELECT 
      b.id, b.booking_number, b.customer_name, b.start_at, b.expected_return_at,
      b.booking_status, b.payment_status,
      v.brand AS vehicle_brand, v.model AS vehicle_model,
      (
        SELECT storage_key 
        FROM vehicle_images vi 
        WHERE vi.vehicle_id = v.id AND vi.is_active = true 
        ORDER BY vi.is_cover DESC, vi.sort_order ASC, vi.created_at ASC 
        LIMIT 1
      ) AS vehicle_cover_image_key,
      bps.base_amount, bps.rental_amount,
      bpv.verified_at AS handover_at,
      brv.returned_at
    FROM bookings b
    JOIN vehicles v ON v.id = b.vehicle_id
    LEFT JOIN booking_pricing_snapshots bps ON bps.booking_id = b.id
    LEFT JOIN booking_pickup_verifications bpv ON bpv.booking_id = b.id AND bpv.is_verified = true
    LEFT JOIN booking_return_verifications brv ON brv.booking_id = b.id
    WHERE b.partner_id = $1
    ORDER BY b.start_at DESC
    LIMIT 100 OFFSET 0`,
    [partnerId]
  );

  // 6. Bookings Count
  await runExplain(
    'Bookings Count',
    `SELECT COUNT(*)::integer AS total FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id WHERE b.partner_id = $1`,
    [partnerId]
  );

  // 7. Wallet Summary
  await runExplain(
    'Wallet Summary',
    `SELECT id, partner_id, available_balance, pending_balance, total_credited, total_debited, currency, created_at, updated_at
    FROM wallets
    WHERE partner_id = $1
    LIMIT 1`,
    [partnerId]
  );

  // 8. Wallet Transactions Count
  await runExplain(
    'Wallet Transactions Count',
    `SELECT COUNT(*)::int AS total FROM wallet_transactions WHERE partner_id = $1`,
    [partnerId]
  );

  // 9. Wallet Transactions Data
  await runExplain(
    'Wallet Transactions Data',
    `SELECT id, wallet_id, partner_id, transaction_type, direction, amount, balance_after, reference_type, reference_id, status, description, metadata, created_at
    FROM wallet_transactions
    WHERE partner_id = $1
    ORDER BY created_at DESC, id DESC
    LIMIT 20 OFFSET 0`,
    [partnerId]
  );

  // 10. Dashboard Stats - Vehicle aggregation
  await runExplain(
    'Dashboard Stats - Vehicle Aggregates',
    `SELECT
      COUNT(*)::int AS total_vehicles,
      COUNT(CASE WHEN rental_status IN ('BOOKED', 'ACTIVE') THEN 1 END)::int AS booked_vehicles,
      COUNT(CASE WHEN rental_status = 'IDLE' AND manual_status = 'ONLINE' THEN 1 END)::int AS available_vehicles,
      COUNT(CASE WHEN manual_status = 'OFFLINE' OR rental_status NOT IN ('IDLE', 'BOOKED', 'ACTIVE') THEN 1 END)::int AS unavailable_vehicles
    FROM vehicles
    WHERE partner_id = $1 AND is_archived = false`,
    [partnerId]
  );

  // 11. Dashboard Stats - Booking aggregation
  await runExplain(
    'Dashboard Stats - Booking Aggregates',
    `SELECT
      COUNT(CASE WHEN booking_status IN ('UPCOMING', 'CONFIRMED') THEN 1 END)::int AS upcoming_bookings,
      COUNT(CASE WHEN booking_status = 'ACTIVE' THEN 1 END)::int AS active_rentals,
      COUNT(CASE WHEN booking_status = 'COMPLETED' THEN 1 END)::int AS completed_bookings,
      COUNT(CASE WHEN booking_status = 'CANCELLED' THEN 1 END)::int AS cancelled_bookings
    FROM bookings
    WHERE partner_id = $1`,
    [partnerId]
  );

  // 12. Dashboard Stats - Earnings aggregation
  await runExplain(
    'Dashboard Stats - Earnings Aggregates',
    `SELECT
      COALESCE(SUM(partner_net_amount), 0)::numeric(12,2) AS total_earnings,
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('month', CURRENT_TIMESTAMP) THEN partner_net_amount ELSE 0 END), 0)::numeric(12,2) AS monthly_earnings,
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('week', CURRENT_TIMESTAMP) THEN partner_net_amount ELSE 0 END), 0)::numeric(12,2) AS weekly_earnings,
      COUNT(CASE WHEN settlement_status = 'PENDING' THEN 1 END)::int AS pending_settlements
    FROM earnings
    WHERE partner_id = $1`,
    [partnerId]
  );

  // 13. Dashboard Stats - Active Rentals Top 5
  await runExplain(
    'Dashboard Stats - Active Rentals List',
    `SELECT
      b.id, b.booking_number, b.customer_name, b.customer_phone, b.start_at, b.expected_return_at,
      v.brand, v.model, v.registration_number
    FROM bookings b
    JOIN vehicles v ON v.id = b.vehicle_id
    WHERE b.partner_id = $1 AND b.booking_status = 'ACTIVE'
    ORDER BY b.start_at ASC
    LIMIT 5`,
    [partnerId]
  );

  // 14. Earnings Summary
  await runExplain(
    'Earnings Summary',
    `SELECT
      COALESCE(SUM(gross_amount), 0)::numeric(12,2) AS total_gross_earnings,
      COALESCE(SUM(partner_net_amount), 0)::numeric(12,2) AS total_net_earnings,
      COALESCE(SUM(CASE WHEN settlement_status = 'SETTLED' THEN partner_net_amount ELSE 0 END), 0)::numeric(12,2) AS total_settled,
      COALESCE(SUM(CASE WHEN settlement_status = 'PENDING' THEN partner_net_amount ELSE 0 END), 0)::numeric(12,2) AS total_pending,
      COUNT(*)::int AS total_records,
      COUNT(CASE WHEN settlement_status = 'SETTLED' THEN 1 END)::int AS settled_count,
      COUNT(CASE WHEN settlement_status = 'PENDING' THEN 1 END)::int AS pending_count
    FROM earnings
    WHERE partner_id = $1`,
    [partnerId]
  );

  // 15. Bank Accounts
  await runExplain(
    'Bank Accounts findByPartnerId',
    `SELECT
      id, partner_id, account_holder_name, account_number_masked,
      ifsc_code, bank_name, is_primary, verification_status,
      created_at, updated_at
    FROM partner_bank_accounts
    WHERE partner_id = $1
    ORDER BY is_primary DESC, created_at DESC`,
    [partnerId]
  );

  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
