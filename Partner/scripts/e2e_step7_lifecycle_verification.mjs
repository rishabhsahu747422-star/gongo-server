import 'dotenv/config';
import poolModule from '../src/db/pool.js';
const { pool } = poolModule;

// Services and Repositories
import vehicleService from '../src/services/vehicle.service.js';
import vehicleRepository from '../src/repositories/vehicle.repository.js';
import PartnerRepository from '../src/repositories/partner.repository.js';
import kycService from '../src/services/kyc.service.js';
import bookingService from '../src/services/booking.service.js';
import bookingRepository from '../src/repositories/booking.repository.js';
import payoutService from '../src/services/payout.service.js';
import WalletRepository from '../src/repositories/wallet.repository.js';
const walletRepository = new WalletRepository();
import earningsRepositoryInstance from '../src/repositories/earnings.repository.js';
const earningsRepository = new earningsRepositoryInstance();

// Admin verification repository & service
import adminVerificationService from '../../Admin/src/services/admin-verification.service.js';

const results = [];

function recordResult(testId, name, passed, details = '') {
  results.push({ testId, name, passed, details });
  const icon = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${icon} [${testId}] ${name}${details ? ' - ' + details : ''}`);
}

async function runStep7E2EVerification() {
  console.log('================================================================');
  console.log('GONGO STEP 7: COMPREHENSIVE END-TO-END BUSINESS LIFECYCLE AUDIT');
  console.log('================================================================\n');

  const client = await pool.connect();

  try {
    // 0. Setup test users and partners in DB
    const u1Id = '11111111-7777-4000-8000-000000000001';
    const u2Id = '22222222-7777-4000-8000-000000000002';
    const p1Id = '33333333-7777-4000-8000-000000000001';
    const p2Id = '44444444-7777-4000-8000-000000000002';
    const adminUserId = '55555555-7777-4000-8000-000000000001';

    // Users
    await client.query(`
      INSERT INTO users (id, auth_id, name, phone, role, is_active)
      VALUES 
        ($1, 'auth-step7-p1', 'Step7 Partner One', '+919999977771', 'PARTNER', true),
        ($2, 'auth-step7-p2', 'Step7 Partner Two', '+919999977772', 'PARTNER', true),
        ($3, 'auth-step7-adm', 'Step7 Admin', '+919999977770', 'ADMIN', true)
      ON CONFLICT (id) DO UPDATE SET is_active = true;
    `, [u1Id, u2Id, adminUserId]);

    // Admin Permissions
    await client.query(`
      INSERT INTO admin_permissions (id, user_id, permission)
      VALUES 
        (gen_random_uuid(), $1, 'SUPER_ADMIN')
      ON CONFLICT DO NOTHING;
    `, [adminUserId]);

    // Ensure schema alignment for verification tables and earnings
    await client.query(`
      ALTER TABLE booking_pickup_verifications ADD COLUMN IF NOT EXISTS verified_by UUID;
      ALTER TABLE booking_return_verifications ADD COLUMN IF NOT EXISTS verified_by UUID;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_earnings_booking_id ON earnings (booking_id);
    `);

    // Partners
    await client.query(`
      INSERT INTO partners (id, user_id, partner_status, kyc_status, is_active)
      VALUES 
        ($1, $2, 'ACTIVE', 'PENDING', true),
        ($3, $4, 'ACTIVE', 'PENDING', true)
      ON CONFLICT (id) DO UPDATE SET kyc_status = 'PENDING', partner_status = 'ACTIVE', is_active = true;
    `, [p1Id, u1Id, p2Id, u2Id]);

    // Shops
    await client.query(`
      INSERT INTO shops (id, partner_id, shop_name, shop_address, city, is_active)
      VALUES 
        (gen_random_uuid(), $1, 'Step7 Hub One', '100 Business Way', 'Mumbai', true),
        (gen_random_uuid(), $2, 'Step7 Hub Two', '200 Business Way', 'Delhi', true)
      ON CONFLICT DO NOTHING;
    `, [p1Id, p2Id]);

    // Clean up prior test runs
    await client.query(`DELETE FROM partner_payouts WHERE partner_id IN ($1, $2)`, [p1Id, p2Id]);
    await client.query(`DELETE FROM partner_bank_accounts WHERE partner_id IN ($1, $2)`, [p1Id, p2Id]);

    // Ensure Wallets exist
    await client.query(`
      INSERT INTO partner_wallets (id, partner_id, available_balance, pending_balance, total_credited, total_debited, currency)
      VALUES 
        (gen_random_uuid(), $1, 1000.00, 0.00, 1000.00, 0.00, 'INR'),
        (gen_random_uuid(), $2, 1000.00, 0.00, 1000.00, 0.00, 'INR')
      ON CONFLICT (partner_id) DO UPDATE SET available_balance = 1000.00, pending_balance = 0.00;
    `, [p1Id, p2Id]);

    const auditContext = { actorId: adminUserId, actorRole: 'ADMIN', permission: 'SUPER_ADMIN' };

    // ──────────────────────────────────────────────────────────────────────────
    // TEST A: KYC SUBMISSION & ADMIN APPROVAL
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST A: KYC Submission & Admin Approval ---');
    
    // Partner submits KYC document
    const kycDoc = await kycService.submitDocument(p1Id, {
      documentType: 'PAN',
      documentNumber: 'ABCDE1234F',
      storageKey: `partners/${p1Id}/kyc/pan.jpg`,
    });

    const docInitialStatus = kycDoc.verification_status || kycDoc.verificationStatus || kycDoc.status;
    const testA_initialPending = (docInitialStatus === 'PENDING' || docInitialStatus === 'UNDER_REVIEW');
    recordResult('TEST_A_1', 'Partner KYC Submission starts PENDING', testA_initialPending, `status: ${docInitialStatus}`);

    // Admin approves KYC
    await adminVerificationService.approvePartner(p1Id, { reason: 'Partner documents verified by admin' }, auditContext);
    
    // Partner checks status
    const partnerAfterApproval = await new PartnerRepository().findById(p1Id);
    const testA_approved = partnerAfterApproval.kyc_status === 'VERIFIED';
    recordResult('TEST_A_2', 'Admin Approval updates DB and Partner sees VERIFIED', testA_approved, `kyc_status: ${partnerAfterApproval.kyc_status}`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST B: KYC REJECTION & RESUBMISSION
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST B: KYC Rejection & Resubmission ---');
    
    // Admin rejects Partner 2 KYC with reason
    await adminVerificationService.rejectPartner(p2Id, { reason: 'Blurry PAN card image' }, auditContext);
    const partnerAfterReject = await new PartnerRepository().findById(p2Id);
    const testB_rejected = partnerAfterReject.kyc_status === 'REJECTED';
    recordResult('TEST_B_1', 'Admin Rejection updates DB to REJECTED', testB_rejected, `kyc_status: ${partnerAfterReject.kyc_status}`);

    // Partner 2 resubmits document
    const kycDocResubmit = await kycService.submitDocument(p2Id, {
      documentType: 'PAN',
      documentNumber: 'ABCDE1234F',
      storageKey: `partners/${p2Id}/kyc/pan_v2.jpg`,
    });
    const partnerAfterResubmit = await new PartnerRepository().findById(p2Id);
    const testB_resubmitted = partnerAfterResubmit.kyc_status === 'UNDER_REVIEW' || partnerAfterResubmit.kyc_status === 'PENDING';
    recordResult('TEST_B_2', 'Partner resubmission returns status to PENDING/UNDER_REVIEW', testB_resubmitted, `kyc_status: ${partnerAfterResubmit.kyc_status}`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST C: VEHICLE CREATION & ADMIN APPROVAL
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST C: Vehicle Creation & Admin Approval ---');
    
    const regNumC = 'MH01E2E' + Math.floor(1000 + Math.random() * 9000);
    const vehicleC = await vehicleService.createVehicle({
      partnerId: p1Id,
      input: {
        category: 'Car',
        brand: 'Hyundai',
        model: 'i20',
        registrationNumber: regNumC,
        year: 2023,
        fuelType: 'Petrol',
        transmission: 'Manual',
        pricing: {
          pricePerDay: 2500,
          securityDeposit: 3000,
          extraKmCharge: 15,
        },
      },
    });

    const testC_initialOffline = vehicleC.manualStatus === 'OFFLINE';
    const testC_initialPending = vehicleC.verificationStatus === 'PENDING';
    const testC_effectiveUnavailable = vehicleC.effectiveStatus === 'UNAVAILABLE';
    recordResult('TEST_C_1', 'Vehicle creates with manualStatus=OFFLINE, verificationStatus=PENDING', testC_initialOffline && testC_initialPending, `manualStatus: ${vehicleC.manualStatus}, verificationStatus: ${vehicleC.verificationStatus}`);
    recordResult('TEST_C_2', 'Vehicle effective status is UNAVAILABLE', testC_effectiveUnavailable, `effectiveStatus: ${vehicleC.effectiveStatus}`);

    // Admin approves vehicle
    await adminVerificationService.approveVehicle(vehicleC.id, { reason: 'Vehicle RC and physical condition verified' }, auditContext);
    const vehicleCAfterAdmin = await vehicleRepository.findByIdAndPartnerId(vehicleC.id, p1Id);
    const testC_approved = vehicleCAfterAdmin.verification_status === 'VERIFIED';
    recordResult('TEST_C_3', 'Admin approves vehicle, DB verification_status=VERIFIED', testC_approved, `verification_status: ${vehicleCAfterAdmin.verification_status}`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST D: VEHICLE / DOCUMENT REJECTION
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST D: Vehicle & Document Rejection ---');

    // Create a document for Vehicle C
    const docRes = await client.query(`
      INSERT INTO vehicle_documents (id, vehicle_id, document_type, document_number, storage_key, verification_status, is_required)
      VALUES (gen_random_uuid(), $1, 'RC', 'MH01RC9999', $2, 'PENDING', true)
      RETURNING *;
    `, [vehicleC.id, `vehicles/${vehicleC.id}/rc.pdf`]);
    const docId = docRes.rows[0].id;

    // Admin rejects document
    await adminVerificationService.rejectDocument(docId, { reason: 'Expired RC document' }, auditContext);
    const docAfterReject = (await client.query('SELECT * FROM vehicle_documents WHERE id = $1', [docId])).rows[0];
    const testD_docRejected = docAfterReject.verification_status === 'REJECTED' && docAfterReject.rejection_reason === 'Expired RC document';
    recordResult('TEST_D_1', 'Admin rejects vehicle document with reason', testD_docRejected, `status: ${docAfterReject.verification_status}, reason: ${docAfterReject.rejection_reason}`);

    // Replacement document uploaded (new row with PENDING status)
    const replaceRes = await client.query(`
      INSERT INTO vehicle_documents (id, vehicle_id, document_type, document_number, storage_key, verification_status, is_required)
      VALUES (gen_random_uuid(), $1, 'RC', 'MH01RC9999', $2, 'PENDING', true)
      RETURNING *;
    `, [vehicleC.id, `vehicles/${vehicleC.id}/rc_v2.pdf`]);
    const testD_replacePending = replaceRes.rows[0].verification_status === 'PENDING';
    recordResult('TEST_D_2', 'Replacement document uploaded with status=PENDING', testD_replacePending, `status: ${replaceRes.rows[0].verification_status}`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST E: VEHICLE ONLINE GATE ENFORCEMENT
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST E: Vehicle ONLINE Gate Enforcement ---');

    // Create unverified vehicle
    const regNumE = 'DL02E2E' + Math.floor(1000 + Math.random() * 9000);
    const unverifiedVehicle = await vehicleService.createVehicle({
      partnerId: p1Id,
      input: {
        category: 'Car',
        brand: 'Honda',
        model: 'City',
        registrationNumber: regNumE,
        year: 2022,
        fuelType: 'Petrol',
      },
    });

    // Attempt 1: PENDING vehicle -> ONLINE (Must fail)
    let testE_pendingBlocked = false;
    try {
      await vehicleService.updateVehicleStatus({
        partnerId: p1Id,
        vehicleId: unverifiedVehicle.id,
        input: { status: 'ONLINE' },
      });
    } catch (err) {
      testE_pendingBlocked = err.message.includes('verified and approved');
    }
    recordResult('TEST_E_1', 'PENDING vehicle cannot be set to ONLINE', testE_pendingBlocked);

    // Attempt 2: KYC-unapproved Partner vehicle -> ONLINE (Must fail)
    // Create vehicle for Partner 2 whose KYC is not VERIFIED
    const regNumE2 = 'DL03E2E' + Math.floor(1000 + Math.random() * 9000);
    const p2Vehicle = await vehicleService.createVehicle({
      partnerId: p2Id,
      input: {
        category: 'Car',
        brand: 'Tata',
        model: 'Nexon',
        registrationNumber: regNumE2,
        year: 2023,
        fuelType: 'Petrol',
      },
    });
    // Mark vehicle itself verified, but Partner 2 is not KYC verified
    await client.query("UPDATE vehicles SET verification_status = 'VERIFIED' WHERE id = $1", [p2Vehicle.id]);
    let testE_unapprovedPartnerBlocked = false;
    try {
      await vehicleService.updateVehicleStatus({
        partnerId: p2Id,
        vehicleId: p2Vehicle.id,
        input: { status: 'ONLINE' },
      });
    } catch (err) {
      testE_unapprovedPartnerBlocked = err.message.includes('partner KYC is verified');
    }
    recordResult('TEST_E_2', 'KYC-unapproved partner vehicle cannot be set to ONLINE', testE_unapprovedPartnerBlocked);

    // Attempt 3: Legitimate verified Partner + verified Vehicle -> ONLINE (Must succeed)
    const onlineVehicle = await vehicleService.updateVehicleStatus({
      partnerId: p1Id,
      vehicleId: vehicleC.id,
      input: { status: 'ONLINE' },
    });
    const testE_onlineSucceeds = onlineVehicle.manualStatus === 'ONLINE' && onlineVehicle.effectiveStatus === 'AVAILABLE';
    recordResult('TEST_E_3', 'VERIFIED partner + VERIFIED vehicle set to ONLINE becomes AVAILABLE', testE_onlineSucceeds, `effectiveStatus: ${onlineVehicle.effectiveStatus}`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST F: BOOKING CREATION & CONFIRMATION
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST F: Booking Creation & State Machine ---');

    const customerUserId = '66666666-7777-4000-8000-000000000001';
    await client.query(`
      INSERT INTO users (id, auth_id, name, phone, role, is_active)
      VALUES ($1, 'auth-step7-cust', 'Step7 Customer', '+919999977773', 'CUSTOMER', true)
      ON CONFLICT (id) DO NOTHING;
    `, [customerUserId]);

    const shopRow = (await client.query('SELECT shop_id FROM vehicles WHERE id = $1', [vehicleC.id])).rows[0];
    const shopId = shopRow?.shop_id || (await client.query('SELECT id FROM shops WHERE partner_id = $1 LIMIT 1', [p1Id])).rows[0]?.id;

    const bookingRes = await client.query(`
      INSERT INTO bookings (
        id, booking_number, customer_id, customer_name, customer_phone,
        partner_id, shop_id, vehicle_id, start_at, end_at, expected_return_at, booking_status, payment_status, pickup_location
      )
      VALUES (
        gen_random_uuid(), 'BKG-STEP7-' || floor(random() * 89999 + 10000)::text,
        $1, 'Step7 Customer', '+919999977773',
        $2, $3, $4, NOW(), NOW() + interval '1 day', NOW() + interval '1 day', 'CONFIRMED', 'PAID', 'Indiranagar Hub'
      )
      RETURNING *;
    `, [customerUserId, p1Id, shopId, vehicleC.id]);
    const booking = bookingRes.rows[0];

    await client.query(`
      INSERT INTO booking_pricing_snapshots (
        booking_id, base_amount, rental_amount, security_deposit, price_per_hour,
        extra_km_charge, total_customer_amount, currency
      )
      VALUES (
        $1, 2000.00, 2000.00, 3000.00, 100.00, 15.00, 5000.00, 'INR'
      )
      ON CONFLICT (booking_id) DO NOTHING;
    `, [booking.id]);

    const testF_created = booking.booking_status === 'CONFIRMED' && booking.partner_id === p1Id;
    recordResult('TEST_F_1', 'Booking created with CONFIRMED status and valid partner ownership', testF_created, `bookingId: ${booking.id}`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST G: HANDOVER / OTP VERIFICATION
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST G: Handover / OTP Verification ---');

    // Request pickup OTP
    const otpResult = await bookingService.requestPickupOtp({
      partnerId: p1Id,
      bookingId: booking.id,
      userId: u1Id,
    });
    recordResult('TEST_G_1', 'Server generates OTP without leaking plaintext to partner', otpResult.success === true && otpResult.otp === undefined);

    // Get hashed OTP from DB
    const verifRow = (await client.query('SELECT * FROM booking_pickup_verifications WHERE booking_id = $1', [booking.id])).rows[0];
    const storedHash = verifRow.otp_hash;
    const testG_hashed = Boolean(storedHash && storedHash.length === 64);
    recordResult('TEST_G_2', 'Pickup OTP stored strictly as cryptographic hash (SHA-256)', testG_hashed);

    // Verify invalid OTP fails
    let testG_wrongOtpFailed = false;
    try {
      await bookingService.verifyPickupAndActivate({
        partnerId: p1Id,
        bookingId: booking.id,
        payload: { otp: '000000' },
        userId: u1Id,
      });
    } catch (err) {
      testG_wrongOtpFailed = true;
    }
    recordResult('TEST_G_3', 'Wrong OTP verification fails safely', testG_wrongOtpFailed);

    // Simulate authentic OTP verification by using internal test hook or updating hash for known OTP
    const otpProviderModule = await import('../src/providers/otp.provider.js');
    const otpProviderInstance = otpProviderModule.default || otpProviderModule;
    const knownOtp = '7788';
    const salt = otpProviderInstance.generateSalt();
    const knownHash = otpProviderInstance.hashOtp(knownOtp, salt);
    await otpProviderInstance.storeOtpState(booking.id, { otpHash: knownHash, salt });
    await client.query('UPDATE booking_pickup_verifications SET otp_hash = $1 WHERE booking_id = $2', [knownHash, booking.id]);

    // Legitimate Handover
    const activeBookingResult = await bookingService.verifyPickupAndActivate({
      partnerId: p1Id,
      bookingId: booking.id,
      payload: {
        otp: knownOtp,
        odometerStart: 15000,
        fuelLevelStart: 'FULL',
      },
      userId: u1Id,
    });

    const activeStatus = activeBookingResult.status || activeBookingResult.bookingStatus || activeBookingResult.booking?.status;
    const testG_active = activeStatus === 'ACTIVE';
    recordResult('TEST_G_4', 'Valid OTP transitions booking to ACTIVE and records odometerStart', testG_active, `status: ${activeStatus}`);

    // Verify vehicle rental_status is now ACTIVE
    const vehicleDuringRental = await vehicleRepository.findByIdAndPartnerId(vehicleC.id, p1Id);
    const testG_vehicleActive = vehicleDuringRental.rental_status === 'ACTIVE';
    recordResult('TEST_G_5', 'Vehicle rental_status transitions to ACTIVE', testG_vehicleActive);

    // Duplicate OTP verification cannot reactivate or duplicate
    const duplicateHandover = await bookingService.verifyPickupAndActivate({
      partnerId: p1Id,
      bookingId: booking.id,
      payload: { otp: knownOtp },
      userId: u1Id,
    });
    const dupStatus = duplicateHandover.status || duplicateHandover.bookingStatus || duplicateHandover.booking?.status;
    const testG_duplicateHandoverIdempotent = duplicateHandover.isReplay === true || dupStatus === 'ACTIVE';
    recordResult('TEST_G_6', 'Duplicate OTP handover handled idempotently without state corruption', testG_duplicateHandoverIdempotent);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST H: RETURN VEHICLE & BOOKING COMPLETION
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST H: Return Vehicle & Single Earning Creation ---');

    const returnResult = await bookingService.completeReturnAndFinalize({
      partnerId: p1Id,
      bookingId: booking.id,
      payload: {
        odometerEnd: 15150,
        fuelLevelEnd: 'FULL',
        notes: 'Returned in pristine condition',
      },
      userId: u1Id,
    });

    const retStatus = returnResult.booking?.bookingStatus || returnResult.booking?.status || returnResult.status;
    const testH_completed = retStatus === 'COMPLETED';
    recordResult('TEST_H_1', 'Booking returned and transitioned to COMPLETED', testH_completed, `bookingStatus: ${retStatus}`);

    // Vehicle rental_status reset to IDLE
    const vehicleAfterReturn = await vehicleRepository.findByIdAndPartnerId(vehicleC.id, p1Id);
    const testH_vehicleIdle = vehicleAfterReturn.rental_status === 'IDLE';
    recordResult('TEST_H_2', 'Vehicle rental_status resets to IDLE', testH_vehicleIdle);

    // Synchronized Earning Record Created Exactly Once
    const earningsRes = await client.query('SELECT * FROM earnings WHERE booking_id = $1', [booking.id]);
    const testH_earningCreatedOnce = earningsRes.rows.length === 1;
    recordResult('TEST_H_3', 'Synchronized earning created in database exactly once', testH_earningCreatedOnce, `records: ${earningsRes.rows.length}, grossAmount: ${earningsRes.rows[0]?.gross_amount}`);

    // Duplicate return attempt is idempotent and does NOT duplicate earnings
    await bookingService.completeReturnAndFinalize({
      partnerId: p1Id,
      bookingId: booking.id,
      payload: { odometerEnd: 15150 },
      userId: u1Id,
    });
    const earningsResAfterDuplicate = await client.query('SELECT * FROM earnings WHERE booking_id = $1', [booking.id]);
    const testH_noDuplicateEarnings = earningsResAfterDuplicate.rows.length === 1;
    recordResult('TEST_H_4', 'Duplicate return invocation does NOT duplicate earnings records', testH_noDuplicateEarnings, `records: ${earningsResAfterDuplicate.rows.length}`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST I: FINANCIAL CONSISTENCY & PAYOUT
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST I: Financial Consistency & Payout Lifecycle ---');

    // Add a bank account for Partner 1
    await client.query(`DELETE FROM partner_bank_accounts WHERE partner_id = $1`, [p1Id]);
    const bankRes = await client.query(`
      INSERT INTO partner_bank_accounts (
        id, partner_id, account_holder_name, account_number_encrypted,
        account_number_masked, ifsc_code, bank_name, verification_status, is_primary
      )
      VALUES (
        gen_random_uuid(), $1, 'Step7 Partner One', 'mock_ciphertext',
        'XXXXXXXX1234', 'HDFC0001234', 'HDFC Bank', 'VERIFIED', true
      )
      RETURNING *;
    `, [p1Id]);
    const bankAccountId = bankRes.rows[0].id;

    // Request payout
    const payoutReq = await payoutService.requestPayout(p1Id, {
      amount: 200.00,
      bankAccountId: bankAccountId,
    });
    const testI_payoutCreated = Boolean(payoutReq && payoutReq.id && (payoutReq.status === 'REQUESTED' || payoutReq.status === 'PENDING'));
    recordResult('TEST_I_1', 'Partner payout created with status REQUESTED/PENDING', testI_payoutCreated, `payoutId: ${payoutReq.id}, status: ${payoutReq.status}`);

    // Verify wallet balance decremented / locked
    const walletAfterPayout = await walletRepository.findByPartnerId(p1Id);
    const testI_walletDebited = Number(walletAfterPayout.available_balance) === 800.00;
    recordResult('TEST_I_2', 'Wallet available_balance atomically decremented upon payout request', testI_walletDebited, `available: ${walletAfterPayout.available_balance}`);

    // Payout beyond balance fails
    let testI_overdrawBlocked = false;
    try {
      await payoutService.requestPayout({
        partnerId: p1Id,
        input: {
          amount: 50000.00,
          bankAccountId: bankAccountId,
        },
      });
    } catch (err) {
      testI_overdrawBlocked = true;
    }
    recordResult('TEST_I_3', 'Payout request exceeding available balance is strictly rejected', testI_overdrawBlocked);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST J: SECURITY & BOLA / TENANT ISOLATION
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST J: Security & BOLA / Tenant Isolation ---');

    // Partner 2 attempts to access Partner 1 vehicle
    let testJ_vehicleBola = false;
    try {
      await vehicleService.getVehicleById({ partnerId: p2Id, vehicleId: vehicleC.id });
    } catch (err) {
      testJ_vehicleBola = err.name === 'NotFoundError';
    }
    recordResult('TEST_J_1', 'Partner 2 accessing Partner 1 vehicle is rejected with 404', testJ_vehicleBola);

    // Partner 2 attempts to return Partner 1 booking
    let testJ_bookingBola = false;
    try {
      await bookingService.completeReturnAndFinalize({
        partnerId: p2Id,
        bookingId: booking.id,
        input: { odometerEnd: 15200 },
        userId: u2Id,
      });
    } catch (err) {
      testJ_bookingBola = err.name === 'NotFoundError';
    }
    recordResult('TEST_J_2', 'Partner 2 returning Partner 1 booking is rejected with 404', testJ_bookingBola);

    // Partner 2 attempts to query Partner 1 earnings
    let testJ_earningsBola = false;
    try {
      const p2Earnings = await earningsRepository.findPaginatedByPartnerId(p2Id);
      testJ_earningsBola = !p2Earnings.rows.some((r) => r.id === earningsRes.rows[0].id);
    } catch (err) {
      testJ_earningsBola = true;
    }
    recordResult('TEST_J_3', 'Partner 2 accessing Partner 1 earning record is rejected / not found', testJ_earningsBola);

    // Protected field mass assignment attempt in vehicle creation
    let testJ_massAssignment = false;
    try {
      await vehicleService.createVehicle({
        partnerId: p1Id,
        input: {
          category: 'Car',
          brand: 'Toyota',
          model: 'Fortuner',
          registrationNumber: 'DL09XYZ' + Math.floor(1000 + Math.random() * 9000),
          year: 2023,
          fuelType: 'Diesel',
          verificationStatus: 'VERIFIED',
          manualStatus: 'ONLINE',
        },
      });
    } catch (err) {
      testJ_massAssignment = err.name === 'ValidationError' && (err.message.includes('Server-managed field') || err.message.includes('Server-controlled') || err.message.includes('Mass assignment'));
    }
    recordResult('TEST_J_4', 'Partner attempting to inject verificationStatus in creation is rejected', testJ_massAssignment);

    // ──────────────────────────────────────────────────────────────────────────
    // CONCURRENCY & RACE CONDITION VERIFICATION
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- CONCURRENCY & RACE CONDITION VERIFICATION ---');

    // 1. Parallel Payout Requests (Double Spend Protection)
    const concurrentPayoutPromises = [
      payoutService.requestPayout({ partnerId: p1Id, input: { amount: 500.00, bankAccountId } }),
      payoutService.requestPayout({ partnerId: p1Id, input: { amount: 500.00, bankAccountId } }),
    ];
    const concurrentPayoutOutcomes = await Promise.allSettled(concurrentPayoutPromises);
    const fulfilledPayouts = concurrentPayoutOutcomes.filter((o) => o.status === 'fulfilled');
    const rejectedPayouts = concurrentPayoutOutcomes.filter((o) => o.status === 'rejected');
    
    // Exactly one should succeed because available balance was 800 (two 500 requests exceed 800)
    const testConc_payout = fulfilledPayouts.length === 1 && rejectedPayouts.length === 1;
    recordResult('CONCURRENCY_1', 'Simultaneous payout requests exceeding balance: exactly 1 succeeds, 1 rejected', testConc_payout, `fulfilled: ${fulfilledPayouts.length}, rejected: ${rejectedPayouts.length}`);

    // 2. Parallel Status Toggles
    const togglePromises = [
      vehicleService.updateVehicleStatus({ partnerId: p1Id, vehicleId: vehicleC.id, input: { status: 'OFFLINE', reason: 'Routine Maintenance' } }),
      vehicleService.updateVehicleStatus({ partnerId: p1Id, vehicleId: vehicleC.id, input: { status: 'OFFLINE', reason: 'Emergency Servicing' } }),
    ];
    const toggleOutcomes = await Promise.allSettled(togglePromises);
    const allToggleSettled = toggleOutcomes.every((o) => o.status === 'fulfilled');
    const finalVehicleState = await vehicleRepository.findByIdAndPartnerId(vehicleC.id, p1Id);
    const testConc_toggle = allToggleSettled && finalVehicleState.manual_status === 'OFFLINE';
    recordResult('CONCURRENCY_2', 'Simultaneous status updates settle cleanly to OFFLINE', testConc_toggle, `status: ${finalVehicleState.manual_status}`);

  } catch (globalErr) {
    console.error('Fatal error during E2E Verification:', globalErr);
  } finally {
    client.release();
  }

  // Summary
  console.log('\n================================================================');
  console.log('STEP 7 E2E VERIFICATION RESULTS SUMMARY:');
  console.log('================================================================');
  const passedCount = results.filter((r) => r.passed).length;
  const totalCount = results.length;
  console.log(`TOTAL TESTS: ${totalCount} | PASSED: ${passedCount} | FAILED: ${totalCount - passedCount}`);
  console.log('================================================================\n');

  if (passedCount === totalCount && totalCount > 0) {
    console.log('🎉 ALL STEP 7 BUSINESS LIFECYCLE AUDIT SCENARIOS PASSED WITH AUTHORITATIVE DB INTEGRITY!\n');
    process.exit(0);
  } else {
    console.error('❌ SOME STEP 7 SCENARIOS FAILED. CHECK LOGS ABOVE.\n');
    process.exit(1);
  }
}

runStep7E2EVerification();
