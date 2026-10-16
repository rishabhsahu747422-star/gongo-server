/* eslint-disable no-console */

'use strict';

const fs = require('fs');
const path = require('path');
const { startLoadTestServer } = require('./server');
const { executeLoadMatrix } = require('./benchmarks/load-matrix');
const { runConcurrencyScenarios } = require('./benchmarks/concurrency-scenarios');
const { runResilienceScenarios } = require('./benchmarks/resilience-scenarios');

/**
 * Formats bytes to megabytes string.
 * @param {number} bytes
 * @returns {string}
 */
function toMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Master load test orchestrator for GONGO Customer Backend — Phase 15.
 */
async function main() {
  console.log('\n================================================================');
  console.log('  GONGO Customer Backend — Phase 15: Load & Performance Benchmark');
  console.log('================================================================\n');

  const startTime = Date.now();
  const initialMemory = process.memoryUsage();

  console.log(`[Info] Node Version: ${process.version}`);
  console.log(`[Info] Platform: ${process.platform} (${process.arch})`);
  console.log(`[Info] Initial Heap Used: ${toMB(initialMemory.heapUsed)}`);
  console.log('[Info] Starting isolated load test server...');

  const serverInstance = await startLoadTestServer();
  console.log(`[Info] Server listening on ${serverInstance.baseUrl}\n`);

  console.log('── Step 1: Executing API Performance Matrix (Autocannon) ────────');
  const matrixResults = await executeLoadMatrix(serverInstance, {
    duration: 2,
    connections: 5,
  });

  console.log('\n── Step 2: Executing Concurrency & Contention Scenarios ─────────');
  const concurrencyResults = await runConcurrencyScenarios(serverInstance);

  console.log('\n── Step 3: Executing Failure Recovery & Resilience Scenarios ───');
  const resilienceResults = await runResilienceScenarios(serverInstance);

  await serverInstance.close();
  console.log('\n[Info] Load test server cleanly stopped.');

  const finalMemory = process.memoryUsage();
  const memoryDelta = finalMemory.heapUsed - initialMemory.heapUsed;
  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);

  // Print Summary Tables
  console.log('\n================================================================');
  console.log('  MEASURED PERFORMANCE RESULTS SUMMARY');
  console.log('================================================================\n');

  console.log('| Endpoint / Scenario | Method | Req/s | Avg (ms) | p50 (ms) | p90 (ms) | p95 (ms) | p99 (ms) | Errors |');
  console.log('|---------------------|:------:|------:|---------:|---------:|---------:|---------:|---------:|-------:|');

  matrixResults.forEach((r) => {
    console.log(
      `| ${r.name.padEnd(40)} | ${r.method.padEnd(6)} | ${String(r.requestsPerSec).padStart(6)} | ${String(r.avgLatency).padStart(8)} | ${String(r.p50).padStart(8)} | ${String(r.p90).padStart(8)} | ${String(r.p95).padStart(8)} | ${String(r.p99).padStart(8)} | ${String(r.errors).padStart(6)} |`,
    );
  });

  console.log('\n── Concurrency Verification ────────────────────────────────────');
  Object.values(concurrencyResults).forEach((c) => {
    const status = c.passed ? 'PASS' : 'FAIL';
    console.log(`[${status}] ${c.name}: Total ${c.totalRequests} reqs (Success: ${c.successCount})`);
  });

  console.log('\n── Resilience Verification ─────────────────────────────────────');
  Object.values(resilienceResults).forEach((r) => {
    const status = r.passed ? 'PASS' : 'FAIL';
    console.log(`[${status}] ${r.name}`);
  });

  console.log('\n── Resource Consumption ────────────────────────────────────────');
  console.log(`Initial Heap: ${toMB(initialMemory.heapUsed)}`);
  console.log(`Final Heap:   ${toMB(finalMemory.heapUsed)}`);
  console.log(`Heap Delta:   ${toMB(memoryDelta)}`);
  console.log(`Total Duration: ${totalDuration}s`);

  // Save JSON summary artifact
  const summaryPayload = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    initialHeapMB: (initialMemory.heapUsed / 1024 / 1024).toFixed(2),
    finalHeapMB: (finalMemory.heapUsed / 1024 / 1024).toFixed(2),
    heapDeltaMB: (memoryDelta / 1024 / 1024).toFixed(2),
    durationSeconds: totalDuration,
    apiMatrix: matrixResults,
    concurrency: concurrencyResults,
    resilience: resilienceResults,
  };

  const resultsPath = path.join(__dirname, 'load-test-results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(summaryPayload, null, 2), 'utf8');
  console.log(`\n[Info] Results JSON saved to: ${resultsPath}\n`);

  // Check if any concurrency or resilience test failed
  const allConcurrencyPassed = Object.values(concurrencyResults).every((c) => c.passed);
  const allResiliencePassed = Object.values(resilienceResults).every((r) => r.passed);
  const allMatrixPassed = matrixResults.every((m) => m.errors === 0);

  if (!allConcurrencyPassed || !allResiliencePassed || !allMatrixPassed) {
    console.error('ERROR: One or more performance checks failed!');
    process.exit(1);
  }

  console.log('All performance and concurrency verifications passed successfully!\n');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Unhandled error during load test execution:', err);
    process.exit(1);
  });
}

module.exports = {
  main,
};
