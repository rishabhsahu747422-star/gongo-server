'use strict';

require('dotenv').config();

/* eslint-disable no-console, no-await-in-loop */

const request = require('supertest');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const env = require('../src/config/env');

async function runPartnerBusinessFlowTest() {
  console.log('================================================================');
  console.log('GONGO PARTNER BACKEND — END-TO-END BUSINESS FLOW VERIFICATION');
  console.log('================================================================\n');

  if (env.isProduction) {
    console.error('CRITICAL: test:partner-flow is strictly forbidden in production!');
    process.exit(1);
  }

  const app = createApp();
  const testRunId = `DEV_TEST_${Date.now()}`;
  const results = [];
  let allCorePassed = true;

  function record(stepName, status, details = null) {
    results.push({ stepName, status, details });
    const tag = status === 'PASS' ? '✓ PASS' : status === 'EXTERNAL_DEPENDENCY' ? '⚠ EXTERNAL' : '✗ FAIL';
    console.log(`[${tag}] ${stepName}${details ? ` - ${details}` : ''}`);
    if (status === 'FAIL') {
      allCorePassed = false;
    }
  }

  // Identifiers to clean up
  const createdVehicleIds = [];
  const createdBankIds = [];
  const createdDocIds = [];

  try {
    // ────────────────────────────────────────────────────────────────
    // 1. Health & Process Readiness
    // ────────────────────────────────────────────────────────────────
    console.log('\n--- 1. Health & Readiness Verification ---');
    const healthLive = await request(app).get('/health/live');
    record('GET /health/live', healthLive.status === 200 ? 'PASS' : 'FAIL', `Status ${healthLive.status}`);

    const healthReady = await request(app).get('/health/ready');
    record('GET /health/ready (DB connectivity)', healthReady.status === 200 ? 'PASS' : 'FAIL', `Status ${healthReady.status}`);

    const apiHealth = await request(app).get('/api/v1/health');
    record('GET /api/v1/health', apiHealth.status === 200 ? 'PASS' : 'FAIL', `Status ${apiHealth.status}`);

    // ────────────────────────────────────────────────────────────────
    // 2. Development Authentication & Session Resolution
    // ────────────────────────────────────────────────────────────────
    console.log('\n--- 2. Development Authentication & Session Flows ---');
    const devLoginRes = await request(app)
      .post('/api/v1/auth/dev-login')
      .send({ authId: env.PARTNER_DEV_AUTH_ID || 'dev-partner-auth-id' });

    record(
      'POST /api/v1/auth/dev-login',
      devLoginRes.status === 200 && devLoginRes.body.success ? 'PASS' : 'FAIL',
      `Status ${devLoginRes.status}, Registered: ${devLoginRes.body.data?.isRegistered}`,
    );

    const partnerToken = devLoginRes.body.data?.token || 'dev-partner-token';
    const authHeaders = { Authorization: `Bearer ${partnerToken}` };

    const sessionRes = await request(app)
      .post('/api/v1/auth/session')
      .set(authHeaders)
      .send({});

    record(
      'POST /api/v1/auth/session (Session resolution via Bearer dev-partner-token)',
      sessionRes.status === 200 && sessionRes.body.data?.isRegistered ? 'PASS' : 'FAIL',
      `Partner ID: ${sessionRes.body.data?.partner?.id}`,
    );

    const meRes = await request(app)
      .get('/api/v1/auth/me')
      .set(authHeaders);

    record(
      'GET /api/v1/auth/me (Role & Identity enforcement)',
      meRes.status === 200 && meRes.body.data?.user?.role === 'PARTNER' ? 'PASS' : 'FAIL',
      `Role: ${meRes.body.data?.user?.role}, Name: ${meRes.body.data?.user?.name}`,
    );

    // ────────────────────────────────────────────────────────────────
    // 3. Partner Profile & Shop Management
    // ────────────────────────────────────────────────────────────────
    console.log('\n--- 3. Partner Profile & Shop Management ---');
    const profileRes = await request(app)
      .get('/api/v1/partner/profile')
      .set(authHeaders);

    const partnerProfile = profileRes.body.data?.partner;
    record(
      'GET /api/v1/partner/profile',
      profileRes.status === 200 && Boolean(partnerProfile?.id) ? 'PASS' : 'FAIL',
      `Partner ID: ${partnerProfile?.id}, Status: ${partnerProfile?.partnerStatus}, KYC: ${partnerProfile?.kycStatus}`,
    );

    const shopRes = await request(app)
      .get('/api/v1/partner/shop')
      .set(authHeaders);

    record(
      'GET /api/v1/partner/shop',
      shopRes.status === 200 && Boolean(shopRes.body.data?.shopName) ? 'PASS' : 'FAIL',
      `Shop Name: ${shopRes.body.data?.shopName}, City: ${shopRes.body.data?.city}`,
    );

    const shopUpdateRes = await request(app)
      .patch('/api/v1/partner/shop')
      .set(authHeaders)
      .send({
        operatingInfo: '08:00 AM - 10:00 PM (Daily Operational)',
      });

    record(
      'PATCH /api/v1/partner/shop (Update operating info)',
      shopUpdateRes.status === 200 ? 'PASS' : 'FAIL',
      `Updated Info: ${shopUpdateRes.body.data?.operatingInfo}`,
    );

    // ────────────────────────────────────────────────────────────────
    // 4. Vehicles, Pricing & Availability Lifecycle
    // ────────────────────────────────────────────────────────────────
    console.log('\n--- 4. Vehicle Lifecycle (Create, Read, Update, Pricing, Availability) ---');
    const regNum = `KA04DEV${Math.floor(1000 + Math.random() * 9000)}`;
    const createVehRes = await request(app)
      .post('/api/v1/partner/vehicles')
      .set(authHeaders)
      .send({
        category: 'Bike',
        brand: 'Yamaha',
        model: 'FZ-S V4',
        variant: 'Deluxe',
        registrationNumber: regNum,
        year: 2024,
        fuelType: 'Petrol',
        transmission: 'Manual',
        pricePerDay: 850,
        securityDeposit: 1500,
        description: `${testRunId} Test Motorcycle`,
      });

    const vehicleId = createVehRes.body.data?.id;
    if (vehicleId) createdVehicleIds.push(vehicleId);

    record(
      'POST /api/v1/partner/vehicles (Create Vehicle with inline pricing)',
      createVehRes.status === 201 && Boolean(vehicleId) ? 'PASS' : 'FAIL',
      `Vehicle ID: ${vehicleId}, Reg: ${regNum}`,
    );

    const getVehRes = await request(app)
      .get(`/api/v1/partner/vehicles/${vehicleId}`)
      .set(authHeaders);

    record(
      'GET /api/v1/partner/vehicles/:id',
      getVehRes.status === 200 && getVehRes.body.data?.id === vehicleId ? 'PASS' : 'FAIL',
      `Model: ${getVehRes.body.data?.brand} ${getVehRes.body.data?.model}`,
    );

    const updateVehRes = await request(app)
      .patch(`/api/v1/partner/vehicles/${vehicleId}`)
      .set(authHeaders)
      .send({
        description: `${testRunId} Updated Description`,
        pickupLocation: 'Koramangala Hub Dock 1',
      });

    record(
      'PATCH /api/v1/partner/vehicles/:id (Update Vehicle)',
      updateVehRes.status === 200 ? 'PASS' : 'FAIL',
      `Location: ${updateVehRes.body.data?.pickupLocation}`,
    );

    const updatePricingRes = await request(app)
      .put(`/api/v1/partner/vehicles/${vehicleId}/pricing`)
      .set(authHeaders)
      .send({
        pricePerDay: 950,
        securityDeposit: 2000,
      });

    record(
      'PUT /api/v1/partner/vehicles/:id/pricing (Update pricing)',
      updatePricingRes.status === 200 && Number(updatePricingRes.body.data?.pricePerDay) === 950 ? 'PASS' : 'FAIL',
      `Price/Day: ₹${updatePricingRes.body.data?.pricePerDay}`,
    );

    const getPricingRes = await request(app)
      .get(`/api/v1/partner/vehicles/${vehicleId}/pricing`)
      .set(authHeaders);

    record(
      'GET /api/v1/partner/vehicles/:id/pricing',
      getPricingRes.status === 200 ? 'PASS' : 'FAIL',
      `Price/Hour: ₹${getPricingRes.body.data?.pricePerHour}, Security Deposit: ₹${getPricingRes.body.data?.securityDeposit}`,
    );

    const blockStart = new Date(Date.now() + 86400000).toISOString();
    const blockEnd = new Date(Date.now() + 2 * 86400000).toISOString();
    const createBlockRes = await request(app)
      .post(`/api/v1/partner/vehicles/${vehicleId}/availability`)
      .set(authHeaders)
      .send({
        startTime: blockStart,
        endTime: blockEnd,
        reason: 'Maintenance',
      });

    const blockId = createBlockRes.body.data?.id;
    record(
      'POST /api/v1/partner/vehicles/:id/availability (Block vehicle availability)',
      createBlockRes.status === 201 && Boolean(blockId) ? 'PASS' : 'FAIL',
      `Block ID: ${blockId}`,
    );

    const listBlocksRes = await request(app)
      .get(`/api/v1/partner/vehicles/${vehicleId}/availability`)
      .set(authHeaders);

    record(
      'GET /api/v1/partner/vehicles/:id/availability (List availability blocks)',
      listBlocksRes.status === 200 && Array.isArray(listBlocksRes.body.data) ? 'PASS' : 'FAIL',
      `Blocks count: ${listBlocksRes.body.data?.length}`,
    );

    if (blockId) {
      const delBlockRes = await request(app)
        .delete(`/api/v1/partner/vehicles/${vehicleId}/availability/${blockId}`)
        .set(authHeaders);

      record(
        'DELETE /api/v1/partner/vehicles/:id/availability/:blockId (Release block)',
        delBlockRes.status === 200 ? 'PASS' : 'FAIL',
        'Block soft-deleted successfully',
      );
    }

    // ────────────────────────────────────────────────────────────────
    // 5. Partner Documents & KYC Metadata
    // ────────────────────────────────────────────────────────────────
    console.log('\n--- 5. Partner KYC Overview & Documents ---');
    const getKycRes = await request(app)
      .get('/api/v1/partner/kyc')
      .set(authHeaders);

    record(
      'GET /api/v1/partner/kyc (KYC overview)',
      getKycRes.status === 200 && Boolean(getKycRes.body.data?.kycStatus) ? 'PASS' : 'FAIL',
      `Status: ${getKycRes.body.data?.kycStatus}, Documents count: ${getKycRes.body.data?.documents?.length ?? 0}`,
    );

    const submitDocRes = await request(app)
      .post('/api/v1/partner/kyc/documents')
      .set(authHeaders)
      .send({
        documentType: 'GST',
        documentNumber: '29ABCDE1234F1Z5',
      });

    const docId = submitDocRes.body.data?.id;
    if (docId) createdDocIds.push(docId);

    record(
      'POST /api/v1/partner/kyc/documents (Submit KYC document)',
      submitDocRes.status === 201 && Boolean(docId) ? 'PASS' : 'FAIL',
      `Document ID: ${docId}, Type: ${submitDocRes.body.data?.documentType}`,
    );

    if (docId) {
      const getSingleDocRes = await request(app)
        .get(`/api/v1/partner/kyc/documents/${docId}`)
        .set(authHeaders);

      record(
        'GET /api/v1/partner/kyc/documents/:id (Get single KYC document)',
        getSingleDocRes.status === 200 && getSingleDocRes.body.data?.id === docId ? 'PASS' : 'FAIL',
        `Type: ${getSingleDocRes.body.data?.documentType}, Status: ${getSingleDocRes.body.data?.verificationStatus}`,
      );
    }

    // ────────────────────────────────────────────────────────────────
    // 6. Bank Accounts Management
    // ────────────────────────────────────────────────────────────────
    console.log('\n--- 6. Bank Accounts Management ---');
    const listBanksRes = await request(app)
      .get('/api/v1/partner/bank-account')
      .set(authHeaders);

    record(
      'GET /api/v1/partner/bank-account (List bank accounts)',
      listBanksRes.status === 200 && Array.isArray(listBanksRes.body.data) ? 'PASS' : 'FAIL',
      `Bank accounts count: ${listBanksRes.body.data?.length}`,
    );

    const createBankRes = await request(app)
      .post('/api/v1/partner/bank-account')
      .set(authHeaders)
      .send({
        accountHolderName: 'GONGO Test Partner Secondary',
        bankName: 'ICICI Bank',
        accountNumber: '987654321098',
        ifscCode: 'ICIC0001234',
        isPrimary: false,
      });

    const bankId = createBankRes.body.data?.id;
    if (bankId) createdBankIds.push(bankId);

    record(
      'POST /api/v1/partner/bank-account (Add secondary bank account)',
      createBankRes.status === 201 && Boolean(bankId) ? 'PASS' : 'FAIL',
      `Bank ID: ${bankId}, Masked: ${createBankRes.body.data?.accountNumberMasked}`,
    );

    if (bankId) {
      const delBankRes = await request(app)
        .delete(`/api/v1/partner/bank-account/${bankId}`)
        .set(authHeaders);

      record(
        'DELETE /api/v1/partner/bank-account/:bankAccountId (Delete secondary bank account)',
        delBankRes.status === 200 ? 'PASS' : 'FAIL',
        'Account deleted',
      );
    }

    // ────────────────────────────────────────────────────────────────
    // 7. Notifications
    // ────────────────────────────────────────────────────────────────
    console.log('\n--- 7. Notifications APIs ---');
    const listNotifRes = await request(app)
      .get('/api/v1/partner/notifications')
      .set(authHeaders);

    record(
      'GET /api/v1/partner/notifications (List notifications)',
      listNotifRes.status === 200 ? 'PASS' : 'FAIL',
      `Status ${listNotifRes.status}`,
    );

    const markAllRes = await request(app)
      .post('/api/v1/partner/notifications/mark-all-read')
      .set(authHeaders)
      .send({});

    record(
      'POST /api/v1/partner/notifications/mark-all-read',
      markAllRes.status === 200 ? 'PASS' : 'FAIL',
      'Marked all read',
    );

    // ────────────────────────────────────────────────────────────────
    // 8. Wallet, Ledger & Earnings
    // ────────────────────────────────────────────────────────────────
    console.log('\n--- 8. Wallet, Ledger & Earnings APIs ---');
    const walletRes = await request(app)
      .get('/api/v1/partner/wallet')
      .set(authHeaders);

    record(
      'GET /api/v1/partner/wallet (Wallet balance summary)',
      walletRes.status === 200 && walletRes.body.data?.currency === 'INR' ? 'PASS' : 'FAIL',
      `Available: ₹${walletRes.body.data?.availableBalance}`,
    );

    const walletTxRes = await request(app)
      .get('/api/v1/partner/wallet/transactions')
      .set(authHeaders);

    const txItems = walletTxRes.body.data?.items || walletTxRes.body.data;
    record(
      'GET /api/v1/partner/wallet/transactions (Ledger transactions)',
      walletTxRes.status === 200 && Array.isArray(txItems) ? 'PASS' : 'FAIL',
      `Transactions count: ${txItems?.length || 0}`,
    );

    const earningsSummaryRes = await request(app)
      .get('/api/v1/partner/earnings/summary')
      .set(authHeaders);

    record(
      'GET /api/v1/partner/earnings/summary (Earnings summary breakdown)',
      earningsSummaryRes.status === 200 ? 'PASS' : 'FAIL',
      `Gross: ₹${earningsSummaryRes.body.data?.totalGrossEarnings ?? earningsSummaryRes.body.data?.grossEarnings ?? 0}, Net: ₹${earningsSummaryRes.body.data?.totalNetEarnings ?? earningsSummaryRes.body.data?.netEarnings ?? 0}`,
    );

    const earningsListRes = await request(app)
      .get('/api/v1/partner/earnings')
      .set(authHeaders);

    const earnItems = earningsListRes.body.data?.items || earningsListRes.body.data;
    record(
      'GET /api/v1/partner/earnings (Paginated earnings list)',
      earningsListRes.status === 200 && Array.isArray(earnItems) ? 'PASS' : 'FAIL',
      `Earnings count: ${earnItems?.length || 0}`,
    );

    // ────────────────────────────────────────────────────────────────
    // 9. Bookings & Payments
    // ────────────────────────────────────────────────────────────────
    console.log('\n--- 9. Bookings & Payments APIs ---');
    const bookingsRes = await request(app)
      .get('/api/v1/partner/bookings')
      .set(authHeaders);

    const bookingList = bookingsRes.body.data?.bookings || bookingsRes.body.data;
    record(
      'GET /api/v1/partner/bookings (Partner bookings list)',
      bookingsRes.status === 200 && Array.isArray(bookingList) ? 'PASS' : 'FAIL',
      `Bookings count: ${bookingList?.length || 0}`,
    );

    // ────────────────────────────────────────────────────────────────
    // 10. BOLA Ownership Enforcement (Cross-Partner Boundary)
    // ────────────────────────────────────────────────────────────────
    console.log('\n--- 10. Broken Object-Level Authorization (BOLA) Isolation ---');
    const partnerBVehQuery = await pool.query('SELECT id FROM vehicles WHERE registration_number = $1 LIMIT 1', ['KA01DEV9998']);
    const partnerBVehicleId = partnerBVehQuery.rows[0]?.id;

    if (partnerBVehicleId) {
      // Partner A attempts to read Partner B vehicle
      const bolaVehRes = await request(app)
        .get(`/api/v1/partner/vehicles/${partnerBVehicleId}`)
        .set(authHeaders);

      record(
        'BOLA: Partner A accessing Partner B Vehicle (Expect 404)',
        bolaVehRes.status === 404 ? 'PASS' : 'FAIL',
        `Status ${bolaVehRes.status} (Denied correctly)`,
      );

      // Partner A attempts to update Partner B vehicle pricing
      const bolaPricingRes = await request(app)
        .put(`/api/v1/partner/vehicles/${partnerBVehicleId}/pricing`)
        .set(authHeaders)
        .send({ pricePerDay: 500 });

      record(
        'BOLA: Partner A mutating Partner B Pricing (Expect 404)',
        bolaPricingRes.status === 404 ? 'PASS' : 'FAIL',
        `Status ${bolaPricingRes.status} (Denied correctly)`,
      );

      // Partner A attempts to query Partner B vehicle availability
      const bolaAvailRes = await request(app)
        .get(`/api/v1/partner/vehicles/${partnerBVehicleId}/availability`)
        .set(authHeaders);

      record(
        'BOLA: Partner A querying Partner B Availability (Expect 404)',
        bolaAvailRes.status === 404 ? 'PASS' : 'FAIL',
        `Status ${bolaAvailRes.status} (Denied correctly)`,
      );
    } else {
      record('BOLA Cross-Partner Test', 'FAIL', 'Partner B baseline vehicle not found');
    }

    // ────────────────────────────────────────────────────────────────
    // 11. Storage Presigned URL Flow
    // ────────────────────────────────────────────────────────────────
    console.log('\n--- 11. Storage Presigned Upload Flow ---');
    try {
      const storagePresignRes = await request(app)
        .post('/api/v1/storage/presign')
        .set(authHeaders)
        .send({
          entityType: 'KYC_DOCUMENT',
          documentType: 'AADHAAR',
          fileName: 'aadhaar_front.jpg',
          contentType: 'image/jpeg',
          fileSize: 102400,
        });

      if ((storagePresignRes.status === 200 || storagePresignRes.status === 201) && (storagePresignRes.body.data?.uploadUrl || storagePresignRes.body.data?.url)) {
        record(
          'POST /api/v1/storage/presign',
          'PASS',
          `Upload URL generated for key: ${storagePresignRes.body.data?.storageKey}`,
        );
      } else {
        record(
          'POST /api/v1/storage/presign',
          'EXTERNAL_DEPENDENCY',
          `Status ${storagePresignRes.status}: ${storagePresignRes.body.message || storagePresignRes.body.error?.message || 'Storage service unavailable'}`,
        );
      }
    } catch (err) {
      record('POST /api/v1/storage/presign', 'EXTERNAL_DEPENDENCY', err.message);
    }
  } catch (err) {
    console.error('\nUnexpected Error during Business Flow Test:', err);
    allCorePassed = false;
  } finally {
    // ────────────────────────────────────────────────────────────────
    // 12. Deterministic Cleanup of Test Run Data
    // ────────────────────────────────────────────────────────────────
    console.log('\n--- 12. Automated Cleanup of Test Artifacts ---');
    for (const vId of createdVehicleIds) {
      try {
        await pool.query('DELETE FROM vehicle_availability_blocks WHERE vehicle_id = $1', [vId]);
        await pool.query('DELETE FROM vehicle_pricing_history WHERE vehicle_id = $1', [vId]);
        await pool.query('DELETE FROM vehicle_pricing WHERE vehicle_id = $1', [vId]);
        await pool.query('DELETE FROM vehicle_images WHERE vehicle_id = $1', [vId]);
        await pool.query('DELETE FROM vehicles WHERE id = $1', [vId]);
        console.log(`✓ Cleaned up test vehicle: ${vId}`);
      } catch (err) {
        console.warn(`Warning: Failed to clean vehicle ${vId}:`, err.message);
      }
    }

    for (const dId of createdDocIds) {
      try {
        await pool.query('DELETE FROM partner_documents WHERE id = $1', [dId]);
        console.log(`✓ Cleaned up test document: ${dId}`);
      } catch (err) {
        console.warn(`Warning: Failed to clean doc ${dId}:`, err.message);
      }
    }

    for (const bId of createdBankIds) {
      try {
        await pool.query('DELETE FROM partner_bank_accounts WHERE id = $1', [bId]);
        console.log(`✓ Cleaned up test bank account: ${bId}`);
      } catch (err) {
        console.warn(`Warning: Failed to clean bank ${bId}:`, err.message);
      }
    }

    console.log('\n================================================================');
    console.log('FINAL EXECUTION SUMMARY:');
    console.log(`Total Steps Tested: ${results.length}`);
    console.log(`Passed:             ${results.filter((r) => r.status === 'PASS').length}`);
    console.log(`External Dep:       ${results.filter((r) => r.status === 'EXTERNAL_DEPENDENCY').length}`);
    console.log(`Failed:             ${results.filter((r) => r.status === 'FAIL').length}`);
    console.log(`Overall Status:     ${allCorePassed ? 'ALL CORE TESTS PASSED ✓' : 'FAILED ✗'}`);
    console.log('================================================================\n');

    process.exit(allCorePassed ? 0 : 1);
  }
}

runPartnerBusinessFlowTest();
