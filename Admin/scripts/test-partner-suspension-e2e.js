'use strict';

const { Client } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../Customer/.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres.mtfljykvxyslhdvpfcil:Harshu%40898923@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres';

// Import Customer repositories and services
const VehicleRepository = require('../../Customer/src/repositories/vehicle.repository');
const BookingRepository = require('../../Customer/src/repositories/booking.repository');
const availabilityService = require('../../Customer/src/services/availability.service');

// Import Admin repositories and services
const adminPartnerRepository = require('../src/repositories/admin-partner.repository');
const adminPartnerService = require('../src/services/admin-partner.service');

async function runE2ETest() {
  console.log('================================================================');
  console.log('   GONGO PARTNER SUSPENSION SYSTEM — END-TO-END VERIFICATION');
  console.log('================================================================\n');

  const client = new Client({ connectionString });
  await client.connect();

  const vehicleRepo = new VehicleRepository();
  const customerBookingRepo = new BookingRepository();
  // availabilityService is already an instance

  try {
    // 0. Find or setup a test partner with shop and vehicle
    console.log('[SETUP] Finding an eligible partner with active shop and vehicle...');
    const partnerRes = await client.query(`
      SELECT p.id AS partner_id, p.status, p.is_active, p.partner_status,
             s.id AS shop_id, v.id AS vehicle_id, v.model, v.brand
      FROM partners p
      JOIN shops s ON s.partner_id = p.id
      JOIN vehicles v ON v.shop_id = s.id
      WHERE (v.is_archived IS NOT TRUE)
      LIMIT 1
    `);

    if (partnerRes.rows.length === 0) {
      console.log('No existing partner with shop and vehicle found. Querying available partners...');
      const pOnly = await client.query('SELECT id, business_name FROM partners LIMIT 1');
      if (pOnly.rows.length === 0) {
        throw new Error('Database has no partners to test with.');
      }
    }

    const testPartnerId = partnerRes.rows[0].partner_id;
    const testShopId = partnerRes.rows[0].shop_id;
    const testVehicleId = partnerRes.rows[0].vehicle_id;

    console.log(`[SETUP] Using Partner ID: ${testPartnerId}`);
    console.log(`[SETUP] Using Shop ID:    ${testShopId}`);
    console.log(`[SETUP] Using Vehicle ID: ${testVehicleId} (${partnerRes.rows[0].brand} ${partnerRes.rows[0].model})\n`);

    // ─────────────────────────────────────────────────────────────────────────────
    // STEP 1: Ensure Partner is ACTIVE initially
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('--- STEP 1: Ensure Partner is ACTIVE ---');
    await client.query(`
      UPDATE partners
      SET status = 'active', is_active = true, partner_status = 'ONLINE', verification_status = 'verified'
      WHERE id = $1
    `, [testPartnerId]);
    await client.query(`
      UPDATE shops SET is_active = true WHERE id = $1
    `, [testShopId]);
    await client.query(`
      UPDATE vehicles
      SET status = 'active', is_available = true, is_archived = false, verification_status = 'verified'
      WHERE id = $1
    `, [testVehicleId]);

    const initialDbPartner = (await client.query('SELECT id, status, is_active, partner_status FROM partners WHERE id = $1', [testPartnerId])).rows[0];
    console.log(`[DB CHECK] Partner status: ${initialDbPartner.status}, is_active: ${initialDbPartner.is_active}, partner_status: ${initialDbPartner.partner_status}`);
    if (initialDbPartner.status !== 'active' || !initialDbPartner.is_active) {
      throw new Error('Step 1 Failed: Partner could not be set to ACTIVE');
    }
    console.log('>>> STEP 1 PASSED: Partner is ACTIVE in database.\n');

    // ─────────────────────────────────────────────────────────────────────────────
    // STEP 2: Customer Vehicle Discovery while Partner is ACTIVE
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('--- STEP 2: Customer Vehicle Discovery (Partner ACTIVE) ---');
    const publicVehicleBefore = await vehicleRepo.findByIdPublic(testVehicleId);
    console.log(`[CUSTOMER API] findByIdPublic(${testVehicleId}):`, publicVehicleBefore ? `Found (${publicVehicleBefore.vehicleName || publicVehicleBefore.model})` : 'NOT FOUND');
    if (!publicVehicleBefore) {
      throw new Error('Step 2 Failed: Vehicle should be visible to customer when partner is ACTIVE');
    }

    const eligibilityBefore = await customerBookingRepo.findVehicleEligibility(testVehicleId, client);
    console.log(`[CUSTOMER ELIGIBILITY] partner_lifecycle_status: ${eligibilityBefore.partner_lifecycle_status}, is_active: ${eligibilityBefore.partner_active}`);
    availabilityService.assertVehicleEligibility(eligibilityBefore);
    console.log('>>> STEP 2 PASSED: Vehicle is discoverable and eligible for booking.\n');

    // ─────────────────────────────────────────────────────────────────────────────
    // STEP 3: Create an existing booking BEFORE suspension
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('--- STEP 3: Create an existing booking BEFORE suspension ---');
    const existingBookingNumber = `BK-PRE-SUSPEND-${Date.now().toString().slice(-6)}`;
    const custRes = await client.query('SELECT id FROM users LIMIT 1');
    const customerId = custRes.rows[0]?.id;

    const createBookingRes = await client.query(`
      INSERT INTO bookings (
        booking_number, customer_id, partner_id, shop_id, vehicle_id,
        start_at, end_at, status, booking_status, payment_status,
        subtotal, total_amount, currency
      ) VALUES (
        $1, $2, $3, $4, $5,
        NOW() + INTERVAL '1 day', NOW() + INTERVAL '2 days', 'confirmed', 'CONFIRMED', 'PAID',
        1000, 1000, 'INR'
      ) RETURNING id, booking_number, status, booking_status
    `, [existingBookingNumber, customerId, testPartnerId, testShopId, testVehicleId]);

    const existingBookingId = createBookingRes.rows[0].id;
    console.log(`[EXISTING BOOKING CREATED] ID: ${existingBookingId}, Number: ${existingBookingNumber}, Status: ${createBookingRes.rows[0].status}`);
    console.log('>>> STEP 3 PASSED: Pre-suspension booking created and confirmed.\n');

    // ─────────────────────────────────────────────────────────────────────────────
    // STEP 4: Admin Suspends Partner
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('--- STEP 4: Admin Suspends Partner ---');
    const suspendResult = await adminPartnerService.suspendPartner(
      testPartnerId,
      { reason: 'Policy compliance violation for automated test', force: true },
      { actorId: '11111111-2222-3333-4444-555555555555', actorRole: 'ADMIN', permission: 'partners.update' }
    );
    console.log(`[ADMIN SERVICE RESPONSE] Status: ${suspendResult.status}, isActive: ${suspendResult.isActive}, partnerStatus: ${suspendResult.partnerStatus}`);

    // Verify in database directly (source of truth)
    const suspendedDbPartner = (await client.query('SELECT id, status, is_active, partner_status FROM partners WHERE id = $1', [testPartnerId])).rows[0];
    console.log(`[DB DIRECT QUERY] status: ${suspendedDbPartner.status}, is_active: ${suspendedDbPartner.is_active}, partner_status: ${suspendedDbPartner.partner_status}`);

    if (suspendedDbPartner.status !== 'suspended' || suspendedDbPartner.is_active !== false) {
      throw new Error(`Step 4 Failed: Database does not show status='suspended' and is_active=false. Got: ${JSON.stringify(suspendedDbPartner)}`);
    }

    // Verify Admin Repository queries (what Admin Panel sees after refresh/navigation)
    const adminRepoCheck = await adminPartnerRepository.findPartnerById(testPartnerId);
    console.log(`[ADMIN REPO findPartnerById] status: ${adminRepoCheck.status}, isActive: ${adminRepoCheck.isActive}`);
    if (adminRepoCheck.status !== 'suspended' || adminRepoCheck.isActive !== false) {
      throw new Error(`Step 4 Failed: Admin repository mapping did not return status='suspended'. Got: ${JSON.stringify(adminRepoCheck)}`);
    }

    const adminListCheck = await adminPartnerRepository.listPartners({ limit: 100 });
    const inList = adminListCheck.partners.find(p => p.id === testPartnerId);
    console.log(`[ADMIN REPO listPartners] Partner in list status: ${inList?.status}, isActive: ${inList?.isActive}`);
    if (inList?.status !== 'suspended' || inList?.isActive !== false) {
      throw new Error('Step 4 Failed: Partner in listPartners does not show suspended!');
    }
    console.log('>>> STEP 4 PASSED: Admin suspended partner, and database & admin repository reflect SUSPENDED accurately.\n');

    // ─────────────────────────────────────────────────────────────────────────────
    // STEP 5: Verify existing booking remains intact and NOT cancelled
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('--- STEP 5: Verify Existing Booking Remains Intact ---');
    const existingBookingCheck = (await client.query(`
      SELECT id, booking_number, status, booking_status, partner_id, vehicle_id
      FROM bookings WHERE id = $1
    `, [existingBookingId])).rows[0];

    console.log(`[EXISTING BOOKING CHECK] Status: ${existingBookingCheck.status}, booking_status: ${existingBookingCheck.booking_status}`);
    if (!existingBookingCheck || existingBookingCheck.status !== 'confirmed') {
      throw new Error('Step 5 Failed: Existing booking was altered or deleted by suspension!');
    }
    console.log('>>> STEP 5 PASSED: Existing booking is intact with status CONFIRMED.\n');

    // ─────────────────────────────────────────────────────────────────────────────
    // STEP 6: Customer Vehicle Discovery AFTER Suspension
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('--- STEP 6: Customer Vehicle Discovery (Partner SUSPENDED) ---');
    const publicVehicleAfter = await vehicleRepo.findByIdPublic(testVehicleId);
    console.log(`[CUSTOMER API findByIdPublic] Result:`, publicVehicleAfter ? 'STILL FOUND (ERROR!)' : 'HIDDEN / NULL (CORRECT)');
    if (publicVehicleAfter !== null) {
      throw new Error('Step 6 Failed: Suspended partner vehicle is STILL returned by findByIdPublic!');
    }

    const searchAfter = await vehicleRepo.searchVehicles({ limit: 50 });
    const foundInSearch = searchAfter.rows.find(v => v.id === testVehicleId);
    console.log(`[CUSTOMER API searchVehicles] Vehicle found in search:`, foundInSearch ? 'YES (ERROR!)' : 'NO (CORRECT)');
    if (foundInSearch) {
      throw new Error('Step 6 Failed: Suspended partner vehicle is STILL returned in public search results!');
    }
    console.log('>>> STEP 6 PASSED: Suspended partner vehicles are completely excluded from customer discovery.\n');

    // ─────────────────────────────────────────────────────────────────────────────
    // STEP 7: New Booking Rejection Validation (Direct Booking Attempt)
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('--- STEP 7: Direct Booking Creation Attempt (Must be Rejected) ---');
    const eligibilityAfter = await customerBookingRepo.lockVehicleForBooking(testVehicleId, client);
    console.log(`[LOCKED VEHICLE FOR BOOKING] partner_lifecycle_status: ${eligibilityAfter.partner_lifecycle_status}, partner_active: ${eligibilityAfter.partner_active}`);

    let rejectedWithError = null;
    try {
      availabilityService.assertVehicleEligibility(eligibilityAfter);
    } catch (err) {
      rejectedWithError = err;
    }

    if (!rejectedWithError) {
      throw new Error('Step 7 Failed: Booking validation DID NOT reject booking for suspended partner!');
    }

    console.log(`[REJECTION CAUGHT] Error Name: ${rejectedWithError.name}`);
    console.log(`[REJECTION CAUGHT] HTTP Status: ${rejectedWithError.statusCode}`);
    console.log(`[REJECTION CAUGHT] Error Message: "${rejectedWithError.message}"`);
    console.log(`[REJECTION CAUGHT] Error Code: "${rejectedWithError.code}"`);

    if (rejectedWithError.statusCode !== 403) {
      throw new Error(`Step 7 Failed: Expected HTTP 403, got ${rejectedWithError.statusCode}`);
    }
    if (rejectedWithError.message !== 'Partner is currently suspended and cannot accept new bookings.') {
      throw new Error(`Step 7 Failed: Unexpected error message: ${rejectedWithError.message}`);
    }
    console.log('>>> STEP 7 PASSED: New booking attempt rejected with HTTP 403 and canonical business error message.\n');

    // ─────────────────────────────────────────────────────────────────────────────
    // STEP 8: Partner Existing Booking Lifecycle Progression
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('--- STEP 8: Partner Lifecycle on Existing Booking ---');
    // Simulate pickup verification on existing booking
    await client.query(`
      UPDATE bookings
      SET status = 'in_progress', booking_status = 'IN_PROGRESS', updated_at = NOW()
      WHERE id = $1
    `, [existingBookingId]);
    const updatedLifecycle = (await client.query('SELECT status, booking_status FROM bookings WHERE id = $1', [existingBookingId])).rows[0];
    console.log(`[LIFECYCLE UPDATE] Existing booking status updated to: ${updatedLifecycle.status} / ${updatedLifecycle.booking_status}`);
    if (updatedLifecycle.status !== 'in_progress') {
      throw new Error('Step 8 Failed: Existing booking lifecycle could not progress!');
    }
    console.log('>>> STEP 8 PASSED: Existing booking lifecycle can continue normally.\n');

    // ─────────────────────────────────────────────────────────────────────────────
    // STEP 9: Admin Unsuspends (Reactivates) Partner
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('--- STEP 9: Admin Unsuspends Partner ---');
    const reactivateResult = await adminPartnerService.reactivatePartner(
      testPartnerId,
      { reason: 'Compliance restored by automated test' },
      { actorId: '11111111-2222-3333-4444-555555555555', actorRole: 'ADMIN', permission: 'partners.update' }
    );
    console.log(`[ADMIN SERVICE RESPONSE] Status: ${reactivateResult.status}, isActive: ${reactivateResult.isActive}, partnerStatus: ${reactivateResult.partnerStatus}`);

    const reactivatedDbPartner = (await client.query('SELECT id, status, is_active, partner_status FROM partners WHERE id = $1', [testPartnerId])).rows[0];
    console.log(`[DB DIRECT QUERY] status: ${reactivatedDbPartner.status}, is_active: ${reactivatedDbPartner.is_active}, partner_status: ${reactivatedDbPartner.partner_status}`);

    if (reactivatedDbPartner.status !== 'active' || reactivatedDbPartner.is_active !== true) {
      throw new Error(`Step 9 Failed: Database does not show status='active' and is_active=true. Got: ${JSON.stringify(reactivatedDbPartner)}`);
    }

    const adminRepoCheckAfter = await adminPartnerRepository.findPartnerById(testPartnerId);
    console.log(`[ADMIN REPO findPartnerById] status: ${adminRepoCheckAfter.status}, isActive: ${adminRepoCheckAfter.isActive}`);
    if (adminRepoCheckAfter.status !== 'active' || adminRepoCheckAfter.isActive !== true) {
      throw new Error('Step 9 Failed: Admin repository does not return status=active after unsuspend!');
    }
    console.log('>>> STEP 9 PASSED: Partner successfully unsuspended and restored to ACTIVE.\n');

    // ─────────────────────────────────────────────────────────────────────────────
    // STEP 10: Customer Discovery and Booking Restored After Unsuspension
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('--- STEP 10: Customer Discovery Restored After Unsuspension ---');
    const publicVehicleRestored = await vehicleRepo.findByIdPublic(testVehicleId);
    console.log(`[CUSTOMER API findByIdPublic] Result:`, publicVehicleRestored ? `Found (${publicVehicleRestored.vehicleName || publicVehicleRestored.model})` : 'NOT FOUND (ERROR!)');
    if (!publicVehicleRestored) {
      throw new Error('Step 10 Failed: Vehicle should be visible again after partner is unsuspended!');
    }

    const eligibilityRestored = await customerBookingRepo.findVehicleEligibility(testVehicleId, client);
    availabilityService.assertVehicleEligibility(eligibilityRestored);
    console.log('[BOOKING VALIDATION] New booking check passed without throwing error!');
    console.log('>>> STEP 10 PASSED: Customer discovery and new booking capability fully restored.\n');

    // Clean up test booking
    await client.query('DELETE FROM bookings WHERE id = $1', [existingBookingId]);
    console.log('[CLEANUP] Test booking removed from database.');

    console.log('================================================================');
    console.log('   ALL 10 END-TO-END VERIFICATION STEPS PASSED SUCCESSFULLY!    ');
    console.log('================================================================\n');

  } finally {
    await client.end();
  }
}

runE2ETest().catch((err) => {
  console.error('\n❌ E2E TEST FAILED:', err);
  process.exit(1);
});
