require('dotenv').config();
const assert = require('assert');
const cancellationService = require('../src/services/cancellation.service');
const CancellationService = cancellationService.constructor;

function runValidationSuite() {
  console.log('=== RUNNING CANCELLATION & REFUND POLICY TEST SUITE ===\n');

  const now = new Date('2026-10-09T12:00:00Z');
  const originalPaidAmount = 1000;

  // Case A: Bike, 0–6 hours before pickup
  console.log('Test A: Bike, 3 hours before pickup (0–6h tier)');
  const resA = CancellationService.calculatePolicy({
    pickupTime: new Date(now.getTime() + 3 * 3600 * 1000), // 3 hours in future
    serverTime: now,
    vehicleCategory: 'BIKE',
    originalPaidAmount,
  });
  console.log('Result A:', {
    category: resA.vehicleCategory,
    hoursBeforePickup: resA.hoursBeforePickup,
    refundPercentage: resA.refundPercentage,
    refundAmount: resA.refundAmount,
    refundable: resA.refundable,
    upiRequired: resA.upiRequired,
    policy: resA.policy.description,
  });
  assert.strictEqual(resA.refundPercentage, 0);
  assert.strictEqual(resA.refundAmount, 0);
  assert.strictEqual(resA.refundable, false);
  assert.strictEqual(resA.upiRequired, false);
  console.log('✓ Test A Passed!\n');

  // Case B: Bike, 6–12 hours before pickup
  console.log('Test B: Bike, 8 hours before pickup (6–12h tier)');
  const resB = CancellationService.calculatePolicy({
    pickupTime: new Date(now.getTime() + 8 * 3600 * 1000), // 8 hours in future
    serverTime: now,
    vehicleCategory: 'BIKE',
    originalPaidAmount,
  });
  console.log('Result B:', {
    category: resB.vehicleCategory,
    hoursBeforePickup: resB.hoursBeforePickup,
    refundPercentage: resB.refundPercentage,
    refundAmount: resB.refundAmount,
    refundable: resB.refundable,
    upiRequired: resB.upiRequired,
    policy: resB.policy.description,
  });
  assert.strictEqual(resB.refundPercentage, 50);
  assert.strictEqual(resB.refundAmount, 500);
  assert.strictEqual(resB.refundable, true);
  assert.strictEqual(resB.upiRequired, true);
  console.log('✓ Test B Passed!\n');

  // Case C: Bike, 12+ hours before pickup
  console.log('Test C: Bike, 20 hours before pickup (12+h tier)');
  const resC = CancellationService.calculatePolicy({
    pickupTime: new Date(now.getTime() + 20 * 3600 * 1000), // 20 hours in future
    serverTime: now,
    vehicleCategory: 'BIKE',
    originalPaidAmount,
  });
  console.log('Result C:', {
    category: resC.vehicleCategory,
    hoursBeforePickup: resC.hoursBeforePickup,
    refundPercentage: resC.refundPercentage,
    refundAmount: resC.refundAmount,
    refundable: resC.refundable,
    upiRequired: resC.upiRequired,
    policy: resC.policy.description,
  });
  assert.strictEqual(resC.refundPercentage, 100);
  assert.strictEqual(resC.refundAmount, 1000);
  assert.strictEqual(resC.refundable, true);
  assert.strictEqual(resC.upiRequired, true);
  console.log('✓ Test C Passed!\n');

  // Case D: Car, 0–12 hours before pickup
  console.log('Test D: Car, 5 hours before pickup (0–12h tier)');
  const resD = CancellationService.calculatePolicy({
    pickupTime: new Date(now.getTime() + 5 * 3600 * 1000), // 5 hours in future
    serverTime: now,
    vehicleCategory: 'CAR',
    originalPaidAmount,
  });
  console.log('Result D:', {
    category: resD.vehicleCategory,
    hoursBeforePickup: resD.hoursBeforePickup,
    refundPercentage: resD.refundPercentage,
    refundAmount: resD.refundAmount,
    refundable: resD.refundable,
    upiRequired: resD.upiRequired,
    policy: resD.policy.description,
  });
  assert.strictEqual(resD.refundPercentage, 0);
  assert.strictEqual(resD.refundAmount, 0);
  assert.strictEqual(resD.refundable, false);
  assert.strictEqual(resD.upiRequired, false);
  console.log('✓ Test D Passed!\n');

  // Case E: Car, 12–24 hours before pickup
  console.log('Test E: Car, 18 hours before pickup (12–24h tier)');
  const resE = CancellationService.calculatePolicy({
    pickupTime: new Date(now.getTime() + 18 * 3600 * 1000), // 18 hours in future
    serverTime: now,
    vehicleCategory: 'CAR',
    originalPaidAmount,
  });
  console.log('Result E:', {
    category: resE.vehicleCategory,
    hoursBeforePickup: resE.hoursBeforePickup,
    refundPercentage: resE.refundPercentage,
    refundAmount: resE.refundAmount,
    refundable: resE.refundable,
    upiRequired: resE.upiRequired,
    policy: resE.policy.description,
  });
  assert.strictEqual(resE.refundPercentage, 50);
  assert.strictEqual(resE.refundAmount, 500);
  assert.strictEqual(resE.refundable, true);
  assert.strictEqual(resE.upiRequired, true);
  console.log('✓ Test E Passed!\n');

  // Case F: Car, 24+ hours before pickup
  console.log('Test F: Car, 36 hours before pickup (24+h tier)');
  const resF = CancellationService.calculatePolicy({
    pickupTime: new Date(now.getTime() + 36 * 3600 * 1000), // 36 hours in future
    serverTime: now,
    vehicleCategory: 'CAR',
    originalPaidAmount,
  });
  console.log('Result F:', {
    category: resF.vehicleCategory,
    hoursBeforePickup: resF.hoursBeforePickup,
    refundPercentage: resF.refundPercentage,
    refundAmount: resF.refundAmount,
    refundable: resF.refundable,
    upiRequired: resF.upiRequired,
    policy: resF.policy.description,
  });
  assert.strictEqual(resF.refundPercentage, 100);
  assert.strictEqual(resF.refundAmount, 1000);
  assert.strictEqual(resF.refundable, true);
  assert.strictEqual(resF.upiRequired, true);
  console.log('✓ Test F Passed!\n');

  console.log('========================================================');
  console.log('ALL 6 CANCELLATION POLICY TEST CASES (A-F) PASSED 100%!');
  console.log('========================================================');
}

runValidationSuite();
