'use strict';

/**
 * End-to-End Verification Script:
 * Tests the entire Partner Payout Request + Admin Manual Payment workflow
 * against the real development PostgreSQL database.
 */

const { query } = require('../src/db/pool');
const adminWalletService = require('../src/services/admin-wallet.service');
const payoutService = require('../../Partner/src/services/payout.service');

let mockAdminUser;

async function runE2ETests() {
  console.log('================================================================');
  console.log('STARTING REAL DB E2E VERIFICATION: PARTNER PAYOUT + ADMIN PAYMENT');
  console.log('================================================================\n');

  // Query a real admin user from users table
  const adminUserRes = await query(`SELECT id, role, email FROM users WHERE role ILIKE 'admin' LIMIT 2`);
  if (adminUserRes.rows.length === 0) {
    throw new Error('No admin user found in database');
  }
  mockAdminUser = {
    id: adminUserRes.rows[0].id,
    role: 'ADMIN',
    email: adminUserRes.rows[0].email,
  };
  const secondAdminUser = adminUserRes.rows.length > 1 ? {
    id: adminUserRes.rows[1].id,
    role: 'ADMIN',
    email: adminUserRes.rows[1].email,
  } : mockAdminUser;

  console.log(`[SETUP] Using Real Admin User: ${mockAdminUser.email} (${mockAdminUser.id})`);

  // Step 0: Identify or create a test partner and ensure linked bank account + wallet
  let partnerRes = await query(`SELECT id, business_name FROM partners LIMIT 1`);
  let partnerId;
  if (partnerRes.rows.length === 0) {
    const newPartner = await query(
      `INSERT INTO partners (business_name, contact_email, contact_phone, status)
       VALUES ('E2E Test Partner', 'e2e-partner@gongo.com', '+919876543210', 'ACTIVE')
       RETURNING id, business_name`
    );
    partnerId = newPartner.rows[0].id;
  } else {
    partnerId = partnerRes.rows[0].id;
  }
  console.log(`[SETUP] Using Partner ID: ${partnerId} (${partnerRes.rows[0]?.business_name || 'Partner'})`);

  // Ensure bank account exists
  let bankRes = await query(
    `SELECT id FROM partner_bank_accounts WHERE partner_id = $1 LIMIT 1`,
    [partnerId]
  );
  let bankAccountId;
  if (bankRes.rows.length === 0) {
    const newBank = await query(
      `INSERT INTO partner_bank_accounts 
        (partner_id, account_holder_name, account_number_masked, ifsc_code, bank_name, upi_id, is_primary, verification_status)
       VALUES ($1, 'E2E Partner Holder', 'XXXX-XXXX-4321', 'HDFC0001234', 'HDFC Bank', 'e2etest@upi', true, 'verified')
       RETURNING id`,
      [partnerId]
    );
    bankAccountId = newBank.rows[0].id;
  } else {
    bankAccountId = bankRes.rows[0].id;
    await query(
      `UPDATE partner_bank_accounts 
       SET verification_status = 'VERIFIED', is_primary = true, upi_id = 'e2etest@upi'
       WHERE id = $1`,
      [bankAccountId]
    );
  }
  console.log(`[SETUP] Using Verified Bank Account ID: ${bankAccountId}`);

  // Ensure wallet exists
  let walletRes = await query(
    `SELECT id, available_balance FROM partner_wallets WHERE partner_id = $1 LIMIT 1`,
    [partnerId]
  );
  let walletId;
  if (walletRes.rows.length === 0) {
    const newWallet = await query(
      `INSERT INTO partner_wallets (partner_id, available_balance, pending_balance, total_debited, currency)
       VALUES ($1, 10000.00, 0.00, 0.00, 'INR')
       RETURNING id, available_balance`,
      [partnerId]
    );
    walletId = newWallet.rows[0].id;
  } else {
    walletId = walletRes.rows[0].id;
  }
  console.log(`[SETUP] Using Wallet ID: ${walletId}\n`);

  // Helper to get wallet live balance directly from DB
  async function getLiveWalletBalance() {
    const r = await query(
      `SELECT available_balance, total_debited FROM partner_wallets WHERE id = $1`,
      [walletId]
    );
    return {
      availableBalance: Number(r.rows[0].available_balance),
      totalDebited: Number(r.rows[0].total_debited),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 1: Partner wallet = ₹10,000. Partner requests ₹4,000.
  // Expected: Wallet = ₹10,000 (NOT deducted!), Payout = PENDING
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('--- TEST 1: Partner requests ₹4,000 with ₹10,000 wallet ---');
  await query(
    `UPDATE partner_wallets SET available_balance = 10000.00, total_debited = 0.00 WHERE id = $1`,
    [walletId]
  );

  const test1Payout = await payoutService.requestPayout(
    partnerId,
    { amount: 4000.00, bankAccountId },
    `idemp-test1-${Date.now()}`
  );

  const t1Wallet = await getLiveWalletBalance();
  console.log(`Requested: ₹4000 | Payout Status: ${test1Payout.status} | Wallet Balance: ₹${t1Wallet.availableBalance}`);
  if (t1Wallet.availableBalance !== 10000.00) {
    throw new Error(`TEST 1 FAILED: Wallet balance was deducted upon request! Expected 10000.00, got ${t1Wallet.availableBalance}`);
  }
  if (!['PENDING', 'pending', 'REQUESTED', 'requested'].includes(test1Payout.status)) {
    throw new Error(`TEST 1 FAILED: Unexpected payout status ${test1Payout.status}`);
  }
  console.log('✓ TEST 1 PASSED: Wallet remains ₹10,000 and payout is PENDING.\n');

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 2: Admin opens payout.
  // Expected: Current wallet = ₹10,000
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('--- TEST 2: Admin opens payout details ---');
  const t2Detail = await adminWalletService.getPayoutById(test1Payout.id);
  const t2AdminWalletBalance = Number(t2Detail.wallet.availableBalance);
  console.log(`Admin sees wallet balance: ₹${t2AdminWalletBalance} for payout PO-${test1Payout.id.slice(0, 8)}`);
  if (t2AdminWalletBalance !== 10000.00) {
    throw new Error(`TEST 2 FAILED: Admin detail wallet balance expected 10000.00, got ${t2AdminWalletBalance}`);
  }
  console.log('✓ TEST 2 PASSED: Admin sees current wallet = ₹10,000.\n');

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 3: Admin manually pays ₹4,000 and enters UTR. Admin marks PAID.
  // Expected: Wallet = ₹6,000, Payout = PAID, Ledger contains exactly one -₹4,000 transaction.
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('--- TEST 3: Admin marks payout as PAID with UTR ---');
  const utrTest3 = `UTR${Date.now()}`;
  const t3Result = await adminWalletService.markPaid(
    test1Payout.id,
    {
      paymentMethod: 'UPI',
      paymentReference: utrTest3,
      notes: 'Manually disbursed via corporate banking',
    },
    mockAdminUser,
    { requestId: 'test3-req' }
  );

  const t3Wallet = await getLiveWalletBalance();
  console.log(`New Wallet Balance: ₹${t3Wallet.availableBalance} | Payout Status: ${t3Result.payout.status}`);

  if (t3Wallet.availableBalance !== 6000.00) {
    throw new Error(`TEST 3 FAILED: Expected wallet balance 6000.00, got ${t3Wallet.availableBalance}`);
  }
  if (String(t3Result.payout.status).toUpperCase() !== 'PAID') {
    throw new Error(`TEST 3 FAILED: Expected status PAID, got ${t3Result.payout.status}`);
  }

  // Check ledger in wallet_transactions
  const txQuery = await query(
    `SELECT id, amount, direction, balance_before, balance_after, reference_id
     FROM wallet_transactions
     WHERE reference_id = $1`,
    [test1Payout.id]
  );
  if (txQuery.rows.length !== 1) {
    throw new Error(`TEST 3 FAILED: Expected exactly 1 ledger transaction, found ${txQuery.rows.length}`);
  }
  const txRow = txQuery.rows[0];
  if (Number(txRow.amount) !== 4000.00 || String(txRow.direction).toUpperCase() !== 'DEBIT') {
    throw new Error(`TEST 3 FAILED: Ledger transaction mismatch: amount=${txRow.amount}, dir=${txRow.direction}`);
  }
  console.log(`Ledger entry confirmed: -₹${txRow.amount} (${txRow.direction}) ref=${txRow.reference_id}`);
  console.log('✓ TEST 3 PASSED: Wallet = ₹6,000, Payout = PAID, exactly one -₹4,000 ledger debit.\n');

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 4: Admin tries to mark same payout PAID again.
  // Expected: Request rejected safely. No second deduction.
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('--- TEST 4: Admin attempts duplicate Mark as Paid on already settled payout ---');
  let duplicatePrevented = false;
  try {
    await adminWalletService.markPaid(
      test1Payout.id,
      { paymentMethod: 'UPI', utr: 'UTR_DUP_123' },
      mockAdminUser
    );
  } catch (err) {
    duplicatePrevented = true;
    console.log(`Safely rejected duplicate payment with error: "${err.message}"`);
  }

  if (!duplicatePrevented) {
    throw new Error('TEST 4 FAILED: Second mark as paid should have thrown ConflictError!');
  }

  const t4Wallet = await getLiveWalletBalance();
  if (t4Wallet.availableBalance !== 6000.00) {
    throw new Error(`TEST 4 FAILED: Double deduction occurred! Expected 6000.00, got ${t4Wallet.availableBalance}`);
  }

  const txCountT4 = await query(
    `SELECT count(*)::int as cnt FROM wallet_transactions WHERE reference_id = $1`,
    [test1Payout.id]
  );
  if (txCountT4.rows[0].cnt !== 1) {
    throw new Error(`TEST 4 FAILED: Found duplicate ledger transactions (${txCountT4.rows[0].cnt})`);
  }
  console.log('✓ TEST 4 PASSED: Duplicate request rejected safely, no second deduction, no duplicate ledger debit.\n');

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 5: Partner requests ₹20,000 while wallet = ₹6,000 (or ₹10,000).
  // Expected: Request rejected.
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('--- TEST 5: Partner requests ₹20,000 with ₹6,000 wallet balance ---');
  let excessiveRequestPrevented = false;
  try {
    await payoutService.requestPayout(
      partnerId,
      { amount: 20000.00, bankAccountId },
      `idemp-test5-${Date.now()}`
    );
  } catch (err) {
    excessiveRequestPrevented = true;
    console.log(`Safely rejected excessive request with: "${err.message}"`);
  }

  if (!excessiveRequestPrevented) {
    throw new Error('TEST 5 FAILED: Excessive payout request should have thrown BadRequestError!');
  }
  console.log('✓ TEST 5 PASSED: Request for ₹20,000 rejected.\n');

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 6: Payout = ₹8,000. Current wallet before finalization = ₹5,000.
  // Expected: Mark as Paid fails with insufficient balance. Wallet remains ₹5,000.
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('--- TEST 6: Mark as Paid when wallet balance drops below payout amount ---');
  // Set wallet to 10,000 and create request for 8,000
  await query(`UPDATE partner_wallets SET available_balance = 10000.00 WHERE id = $1`, [walletId]);
  const test6Payout = await payoutService.requestPayout(
    partnerId,
    { amount: 8000.00, bankAccountId },
    `idemp-test6-${Date.now()}`
  );

  // Now simulate balance drop before admin finalization (e.g. balance dropped to ₹5,000)
  await query(`UPDATE partner_wallets SET available_balance = 5000.00 WHERE id = $1`, [walletId]);

  let insufficientBalancePrevented = false;
  try {
    await adminWalletService.markPaid(
      test6Payout.id,
      { paymentMethod: 'UPI', utr: 'UTR_TEST6' },
      mockAdminUser
    );
  } catch (err) {
    insufficientBalancePrevented = true;
    console.log(`Safely rejected payment due to insufficient balance: "${err.message}" [code: ${err.code}]`);
    if (err.code !== 'INSUFFICIENT_WALLET_BALANCE') {
      throw new Error(`TEST 6 FAILED: Expected error code INSUFFICIENT_WALLET_BALANCE, got ${err.code}`);
    }
  }

  if (!insufficientBalancePrevented) {
    throw new Error('TEST 6 FAILED: Mark as Paid should have failed when available balance < payout amount!');
  }

  const t6Wallet = await getLiveWalletBalance();
  if (t6Wallet.availableBalance !== 5000.00) {
    throw new Error(`TEST 6 FAILED: Wallet balance was corrupted! Expected 5000.00, got ${t6Wallet.availableBalance}`);
  }
  console.log('✓ TEST 6 PASSED: Mark as Paid failed with INSUFFICIENT_WALLET_BALANCE, wallet remains ₹5,000.\n');

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 7: Admin rejects ₹4,000 payout.
  // Expected: Wallet remains unchanged.
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('--- TEST 7: Admin rejects payout request ---');
  await query(`UPDATE partner_wallets SET available_balance = 10000.00 WHERE id = $1`, [walletId]);
  const test7Payout = await payoutService.requestPayout(
    partnerId,
    { amount: 4000.00, bankAccountId },
    `idemp-test7-${Date.now()}`
  );

  const t7RejectResult = await adminWalletService.rejectPayout(
    test7Payout.id,
    { reason: 'Bank IFSC code mismatch' },
    mockAdminUser,
    { requestId: 'test7-req' }
  );

  const t7Wallet = await getLiveWalletBalance();
  console.log(`Payout Status after reject: ${t7RejectResult.status} | Wallet Balance: ₹${t7Wallet.availableBalance}`);

  if (t7Wallet.availableBalance !== 10000.00) {
    throw new Error(`TEST 7 FAILED: Wallet balance changed on rejection! Expected 10000.00, got ${t7Wallet.availableBalance}`);
  }
  if (String(t7RejectResult.status).toUpperCase() !== 'REJECTED') {
    throw new Error(`TEST 7 FAILED: Payout status expected REJECTED, got ${t7RejectResult.status}`);
  }
  console.log('✓ TEST 7 PASSED: Payout rejected and wallet remains unchanged at ₹10,000.\n');

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 8: Two admins simultaneously mark the same payout as PAID.
  // Expected: Exactly one succeeds. Exactly one wallet deduction. Exactly one ledger debit.
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('--- TEST 8: Concurrency protection (two simultaneous Mark as Paid calls) ---');
  await query(`UPDATE partner_wallets SET available_balance = 10000.00 WHERE id = $1`, [walletId]);
  const test8Payout = await payoutService.requestPayout(
    partnerId,
    { amount: 4000.00, bankAccountId },
    `idemp-test8-${Date.now()}`
  );

  const results = await Promise.allSettled([
    adminWalletService.markPaid(
      test8Payout.id,
      { paymentMethod: 'UPI', utr: 'UTR_RACE_ADMIN_1' },
      mockAdminUser
    ),
    adminWalletService.markPaid(
      test8Payout.id,
      { paymentMethod: 'UPI', utr: 'UTR_RACE_ADMIN_2' },
      secondAdminUser
    ),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');

  console.log(`Concurrent results: ${fulfilled.length} fulfilled, ${rejected.length} rejected`);
  if (fulfilled.length !== 1 || rejected.length !== 1) {
    throw new Error(`TEST 8 FAILED: Expected exactly 1 success and 1 rejection, got ${fulfilled.length} fulfilled and ${rejected.length} rejected`);
  }

  const t8Wallet = await getLiveWalletBalance();
  if (t8Wallet.availableBalance !== 6000.00) {
    throw new Error(`TEST 8 FAILED: Double deduction! Expected wallet balance 6000.00, got ${t8Wallet.availableBalance}`);
  }

  const t8TxCount = await query(
    `SELECT count(*)::int as cnt FROM wallet_transactions WHERE reference_id = $1`,
    [test8Payout.id]
  );
  if (t8TxCount.rows[0].cnt !== 1) {
    throw new Error(`TEST 8 FAILED: Double ledger insertion! Found ${t8TxCount.rows[0].cnt} transactions`);
  }
  console.log('✓ TEST 8 PASSED: Exactly one admin succeeded, exactly one deduction, exactly one ledger debit.\n');

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 9: Refresh Admin page after payment.
  // Expected: Data remains correct from DB.
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('--- TEST 9: Refresh Admin page / re-read from DB ---');
  const t9Detail = await adminWalletService.getPayoutById(test8Payout.id);
  console.log(`Re-read payout: status=${t9Detail.status}, paymentReference=${t9Detail.paymentReference}, wallet available=${t9Detail.wallet.availableBalance}`);

  if (String(t9Detail.status).toUpperCase() !== 'PAID') {
    throw new Error(`TEST 9 FAILED: Payout status in DB expected PAID, got ${t9Detail.status}`);
  }
  if (!t9Detail.paymentReference || !t9Detail.paymentReference.startsWith('UTR_RACE')) {
    throw new Error(`TEST 9 FAILED: Payment reference missing in DB!`);
  }
  if (Number(t9Detail.wallet.availableBalance) !== 6000.00) {
    throw new Error(`TEST 9 FAILED: Wallet balance in DB expected 6000.00, got ${t9Detail.wallet.availableBalance}`);
  }
  console.log('✓ TEST 9 PASSED: Data remains consistent and accurate from DB.\n');

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 10: Partner opens payout history.
  // Expected: PAID payout and UTR are visible.
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('--- TEST 10: Partner views payout history ---');
  const partnerPayouts = await payoutService.listPayouts(partnerId, { limit: 10 });
  const list = partnerPayouts.items || partnerPayouts.payouts || [];
  const paidPo = list.find((p) => p.id === test8Payout.id);

  if (!paidPo) {
    throw new Error(`TEST 10 FAILED: Paid payout ${test8Payout.id} not found in partner payout history`);
  }
  console.log(`Partner sees payout: status=${paidPo.status}, amount=₹${paidPo.amount}, UTR=${paidPo.paymentReference || paidPo.utr}`);
  if (String(paidPo.status).toUpperCase() !== 'PAID') {
    throw new Error(`TEST 10 FAILED: Expected PAID status in partner history, got ${paidPo.status}`);
  }
  if (!paidPo.paymentReference && !paidPo.utr) {
    throw new Error(`TEST 10 FAILED: UTR / payment reference not visible in partner history`);
  }
  console.log('✓ TEST 10 PASSED: Partner sees PAID status and UTR in payout history.\n');

  console.log('================================================================');
  console.log('ALL 10 E2E PRODUCTION WORKFLOW TESTS PASSED CLEANLY ON REAL DB!');
  console.log('================================================================');
}

runE2ETests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('E2E TEST FAILURE:', err);
    process.exit(1);
  });
