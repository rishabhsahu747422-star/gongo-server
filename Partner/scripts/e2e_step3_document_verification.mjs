import 'dotenv/config';
import poolModule from '../src/db/pool.js';
const { pool, query } = poolModule;
import vehicleService from '../src/services/vehicle.service.js';
import vehicleRepository from '../src/repositories/vehicle.repository.js';
import PartnerRepository from '../src/repositories/partner.repository.js';

async function runE2EVerification() {
  console.log('====================================================');
  console.log('STEP 3: END-TO-END VEHICLE DOCUMENT VERIFICATION TEST');
  console.log('====================================================\n');

  const partner1Id = '99999999-9999-9999-9999-999999999991';
  const partner2Id = '99999999-9999-9999-9999-999999999992';

  const client = await pool.connect();

  try {
    // 0. Ensure test partners exist in database
    let pRes = await client.query('SELECT id FROM partners LIMIT 2');
    let partner1Id, partner2Id;

    if (pRes.rows.length >= 2) {
      partner1Id = pRes.rows[0].id;
      partner2Id = pRes.rows[1].id;
    } else {
      partner1Id = '99999999-9999-9999-9999-999999999991';
      partner2Id = '99999999-9999-9999-9999-999999999992';
      const u1 = '88888888-8888-8888-8888-888888888881';
      const u2 = '88888888-8888-8888-8888-888888888882';

      await client.query(`
        INSERT INTO users (id, auth_id, name, phone, role, is_active)
        VALUES 
          ($1, 'auth-p1', 'Partner One', '+919999999991', 'PARTNER', true),
          ($2, 'auth-p2', 'Partner Two', '+919999999992', 'PARTNER', true)
        ON CONFLICT (id) DO NOTHING
      `, [u1, u2]);

      await client.query(`
        INSERT INTO partners (id, user_id, partner_status, kyc_status, is_active)
        VALUES 
          ($1, $2, 'ACTIVE', 'VERIFIED', true),
          ($3, $4, 'ACTIVE', 'VERIFIED', true)
        ON CONFLICT (id) DO NOTHING
      `, [partner1Id, u1, partner2Id, u2]);
    }

    console.log(`Using Partner 1: ${partner1Id}`);
    console.log(`Using Partner 2: ${partner2Id}`);

    console.log('1. Creating Vehicle as Partner 1...');
    const vehicle = await vehicleService.createVehicle({
      partnerId: partner1Id,
      input: {
        category: 'Car',
        brand: 'Maruti',
        model: 'Swift',
        registrationNumber: 'DL01E2E' + Math.floor(1000 + Math.random() * 9000),
        year: 2023,
        fuelType: 'Petrol',
        transmission: 'Manual',
        seats: 5,
        pickupLocation: 'Connaught Place',
        pricePerDay: 2000,
        securityDeposit: 3000,
      },
    });

    console.log(`   Vehicle created: ${vehicle.id}`);
    console.log(`   Initial verificationStatus: ${vehicle.verificationStatus}`);
    console.log(`   Initial effectiveStatus: ${vehicle.effectiveStatus}`);
    if (vehicle.verificationStatus !== 'PENDING') {
      throw new Error(`FAIL: Initial vehicle verification status must be PENDING, got: ${vehicle.verificationStatus}`);
    }

    console.log('\n2. Testing unverified vehicle cannot go ONLINE...');
    let onlineBlocked = false;
    try {
      await vehicleService.updateVehicleStatus({
        partnerId: partner1Id,
        vehicleId: vehicle.id,
        input: { manualStatus: 'ONLINE' },
      });
    } catch (err) {
      onlineBlocked = true;
      console.log(`   Blocked as expected: ${err.message}`);
    }
    if (!onlineBlocked) {
      throw new Error('FAIL: Unverified vehicle was allowed to go ONLINE!');
    }

    console.log('\n3. Partner 1 submits RC Document (Evidence)...');
    const rcStorageKey = `partners/${partner1Id}/vehicles/${vehicle.id}/documents/rc/rc-v1.pdf`;
    const rcDoc = await vehicleService.createVehicleDocument({
      partnerId: partner1Id,
      input: {
        vehicleId: vehicle.id,
        documentType: 'RC',
        documentNumber: 'RC-12345',
        storageKey: rcStorageKey,
      },
    });
    console.log(`   RC Document ID: ${rcDoc.id}`);
    console.log(`   Status: ${rcDoc.verificationStatus}, Version: ${rcDoc.version}`);
    if (rcDoc.verificationStatus !== 'PENDING' || rcDoc.version !== 1) {
      throw new Error('FAIL: RC document did not enter PENDING version 1');
    }

    console.log('\n4. Partner 1 submits Insurance Document (Evidence)...');
    const insStorageKey = `partners/${partner1Id}/vehicles/${vehicle.id}/documents/insurance/ins-v1.pdf`;
    const insDoc = await vehicleService.createVehicleDocument({
      partnerId: partner1Id,
      input: {
        vehicleId: vehicle.id,
        documentType: 'Insurance',
        documentNumber: 'POL-99999',
        storageKey: insStorageKey,
      },
    });
    console.log(`   Insurance Document ID: ${insDoc.id}`);
    console.log(`   Status: ${insDoc.verificationStatus}, Version: ${insDoc.version}`);
    if (insDoc.verificationStatus !== 'PENDING') {
      throw new Error('FAIL: Insurance document did not enter PENDING');
    }

    console.log('\n5. Malicious client attempts to inject status: APPROVED or verified: true...');
    let massAssignmentBlocked = false;
    try {
      await vehicleService.createVehicleDocument({
        partnerId: partner1Id,
        input: {
          vehicleId: vehicle.id,
          documentType: 'PUC',
          status: 'APPROVED',
          verified: true,
        },
      });
    } catch (err) {
      massAssignmentBlocked = true;
      console.log(`   Blocked as expected with code: ${err.code} - ${err.message}`);
    }
    if (!massAssignmentBlocked) {
      throw new Error('FAIL: Malicious verification fields were accepted!');
    }

    console.log('\n6. Testing BOLA protection (Partner 2 attempts to upload document to Partner 1 vehicle)...');
    let bolaBlocked = false;
    try {
      await vehicleService.createVehicleDocument({
        partnerId: partner2Id,
        input: {
          vehicleId: vehicle.id,
          documentType: 'PUC',
          storageKey: `partners/${partner2Id}/vehicles/${vehicle.id}/documents/puc.pdf`,
        },
      });
    } catch (err) {
      bolaBlocked = true;
      console.log(`   Blocked as expected: ${err.message}`);
    }
    if (!bolaBlocked) {
      throw new Error('FAIL: Cross-partner document submission was allowed!');
    }

    console.log('\n7. Admin verification: Approving RC and Rejecting Insurance...');
    await client.query(`
      UPDATE vehicle_documents
      SET verification_status = 'VERIFIED', verified_at = NOW()
      WHERE id = $1
    `, [rcDoc.id]);

    await client.query(`
      UPDATE vehicle_documents
      SET verification_status = 'REJECTED', rejection_reason = 'Blurry photograph of policy number'
      WHERE id = $1
    `, [insDoc.id]);

    const updatedRC = await vehicleService.getVehicleDocumentById({
      partnerId: partner1Id,
      documentId: rcDoc.id,
    });
    const updatedIns = await vehicleService.getVehicleDocumentById({
      partnerId: partner1Id,
      documentId: insDoc.id,
    });

    console.log(`   RC Verified Status: ${updatedRC.verificationStatus}`);
    console.log(`   Insurance Status: ${updatedIns.verificationStatus}, Reason: "${updatedIns.rejectionReason}"`);
    if (updatedRC.verificationStatus !== 'VERIFIED' || updatedIns.verificationStatus !== 'REJECTED') {
      throw new Error('FAIL: Document status did not update properly after admin action');
    }

    console.log('\n8. Partner resubmits rejected Insurance (Replacement upload)...');
    const insV2StorageKey = `partners/${partner1Id}/vehicles/${vehicle.id}/documents/insurance/ins-v2.pdf`;
    const insReplacement = await vehicleService.createVehicleDocument({
      partnerId: partner1Id,
      input: {
        vehicleId: vehicle.id,
        documentType: 'Insurance',
        documentNumber: 'POL-99999-REPLACEMENT',
        storageKey: insV2StorageKey,
      },
    });

    console.log(`   Replacement Insurance Document ID: ${insReplacement.id}`);
    console.log(`   Status: ${insReplacement.verificationStatus}, Version: ${insReplacement.version}`);
    if (insReplacement.verificationStatus !== 'PENDING' || insReplacement.version !== 2) {
      throw new Error(`FAIL: Replacement did not enter PENDING as version 2, got version: ${insReplacement.version}`);
    }

    console.log('\n9. Admin approves replacement Insurance and verifies vehicle...');
    await client.query(`
      UPDATE vehicle_documents
      SET verification_status = 'VERIFIED', verified_at = NOW()
      WHERE id = $1
    `, [insReplacement.id]);

    await client.query(`
      UPDATE vehicles
      SET verification_status = 'VERIFIED'
      WHERE id = $1
    `, [vehicle.id]);

    console.log('\n10. Partner brings verified vehicle ONLINE...');
    const onlineVehicle = await vehicleService.updateVehicleStatus({
      partnerId: partner1Id,
      vehicleId: vehicle.id,
      input: { manualStatus: 'ONLINE' },
    });

    console.log(`   Updated manualStatus: ${onlineVehicle.manualStatus}`);
    console.log(`   Effective status: ${onlineVehicle.effectiveStatus}`);
    if (onlineVehicle.effectiveStatus !== 'AVAILABLE') {
      throw new Error(`FAIL: Verified online vehicle should be AVAILABLE, got: ${onlineVehicle.effectiveStatus}`);
    }

    console.log('\n====================================================');
    console.log('ALL E2E STEP 3 VERIFICATION CHECKS PASSED PERFECTLY!');
    console.log('====================================================');
  } finally {
    // Cleanup created test records
    await client.query("DELETE FROM vehicle_documents WHERE vehicle_id IN (SELECT id FROM vehicles WHERE registration_number LIKE 'DL01E2E%')");
    await client.query("DELETE FROM vehicle_pricing WHERE vehicle_id IN (SELECT id FROM vehicles WHERE registration_number LIKE 'DL01E2E%')");
    await client.query("DELETE FROM vehicles WHERE registration_number LIKE 'DL01E2E%'");
    client.release();
  }
}

runE2EVerification()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nE2E VERIFICATION FAILED:', err);
    process.exit(1);
  });
