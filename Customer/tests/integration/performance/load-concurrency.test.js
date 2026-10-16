'use strict';

const { startLoadTestServer } = require('../../load/server');
const { runConcurrencyScenarios } = require('../../load/benchmarks/concurrency-scenarios');
const { runResilienceScenarios } = require('../../load/benchmarks/resilience-scenarios');

describe('Phase 15 — Load, Concurrency & Resilience Integration Tests', () => {
  let serverInstance;

  beforeAll(async () => {
    serverInstance = await startLoadTestServer();
  });

  afterAll(async () => {
    if (serverInstance && serverInstance.close) {
      await serverInstance.close();
    }
  });

  describe('Concurrency Scenarios (Zero Contention Corruption)', () => {
    it('executes all 5 concurrency scenarios with complete state consistency', async () => {
      const results = await runConcurrencyScenarios(serverInstance);

      // Scenario 1: Same Vehicle Contention
      expect(results.scenario1.passed).toBe(true);
      expect(results.scenario1.successCount).toBe(1);
      expect(results.scenario1.conflictCount).toBe(results.scenario1.totalRequests - 1);
      expect(results.scenario1.doubleBookingPrevented).toBe(true);

      // Scenario 2: Different Vehicles Concurrency
      expect(results.scenario2.passed).toBe(true);
      expect(results.scenario2.successCount).toBe(results.scenario2.totalRequests);
      expect(results.scenario2.failCount).toBe(0);

      // Scenario 3: Limited Coupon Contention
      expect(results.scenario3.passed).toBe(true);
      expect(results.scenario3.successCount).toBe(results.scenario3.usageLimit);
      expect(results.scenario3.dbRedemptionCount).toBe(results.scenario3.usageLimit);
      expect(results.scenario3.limitRespected).toBe(true);

      // Scenario 4: Payment Idempotency
      expect(results.scenario4.passed).toBe(true);
      expect(results.scenario4.distinctOrderIdsReturned).toBe(1);
      expect(results.scenario4.dbPaymentRecordCount).toBe(1);

      // Scenario 5: Duplicate Webhook Replay
      expect(results.scenario5.passed).toBe(true);
      // Raw DB values (lowercase canonical constants in src/constants/payment.js & booking.js)
      expect(results.scenario5.finalPaymentStatus).toBe('paid');
      expect(results.scenario5.finalBookingStatus).toBe('payment_completed');
    }, 45000);
  });

  describe('Failure Recovery & Resilience Scenarios', () => {
    it('executes all resilience scenarios cleanly without connection leaks or orphaned state', async () => {
      const results = await runResilienceScenarios(serverInstance);

      expect(results.fcmFailureResilience.passed).toBe(true);
      expect(results.fcmFailureResilience.bookingSucceeded).toBe(true);

      expect(results.cashfreeFailureHandling.passed).toBe(true);
      expect(results.cashfreeFailureHandling.bookingPreservedStatus).toBe('PENDING');

      expect(results.dbConnectionRelease.passed).toBe(true);
    }, 30000);
  });
});
