import 'dotenv/config';
import request from 'supertest';
import poolModule from '../src/db/pool.js';
const { pool } = poolModule;
import appModule from '../src/app.js';
const { createApp } = appModule;

function calculatePercentiles(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.50)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const avg = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
  return { min, max, avg, p50, p95, p99 };
}

async function runBenchmark() {
  console.log('================================================================');
  console.log('STEP 9: PERFORMANCE BENCHMARK & REGRESSION AUDIT');
  console.log('================================================================\n');

  const app = createApp();

  // 1. Resolve or seed a test partner in DB
  const client = await pool.connect();
  let partnerId;
  let vehicleId;
  const token = 'Bearer dev-partner-token';

  try {
    const pRes = await client.query(`
      SELECT p.id as partner_id, v.id as vehicle_id
      FROM partners p
      LEFT JOIN vehicles v ON v.partner_id = p.id
      WHERE p.is_active = true
      LIMIT 1;
    `);

    if (pRes.rows.length > 0) {
      partnerId = pRes.rows[0].partner_id;
      vehicleId = pRes.rows[0].vehicle_id;
    }
  } finally {
    client.release();
  }

  const endpoints = [
    { name: 'Health Check (/health/live)', path: '/health/live', auth: false },
    { name: 'Readiness Probe (/health/ready)', path: '/health/ready', auth: false },
    { name: 'Authentication Session (/api/v1/auth/session)', path: '/api/v1/auth/session', auth: true },
    { name: 'Dashboard Stats (/api/v1/partner/dashboard/stats)', path: '/api/v1/partner/dashboard/stats', auth: true },
    { name: 'Vehicle Listing (/api/v1/partner/vehicles?limit=20)', path: '/api/v1/partner/vehicles?limit=20', auth: true },
    { name: 'Booking Listing (/api/v1/partner/bookings?limit=20)', path: '/api/v1/partner/bookings?limit=20', auth: true },
    { name: 'Earnings Summary (/api/v1/partner/earnings/summary)', path: '/api/v1/partner/earnings/summary', auth: true },
    { name: 'Wallet Summary (/api/v1/partner/wallet)', path: '/api/v1/partner/wallet', auth: true },
    { name: 'Bank Accounts (/api/v1/partner/bank-account)', path: '/api/v1/partner/bank-account', auth: true },
  ];

  if (vehicleId) {
    endpoints.push({
      name: `Vehicle Detail (/api/v1/partner/vehicles/${vehicleId})`,
      path: `/api/v1/partner/vehicles/${vehicleId}`,
      auth: true,
    });
  }

  const benchmarkResults = [];
  const WARM_ITERATIONS = 20;

  for (const ep of endpoints) {
    process.stdout.write(`Benchmarking ${ep.name}... `);

    // Cold request measurement
    const tColdStart = Date.now();
    let reqCold = request(app).get(ep.path);
    if (ep.auth) reqCold = reqCold.set('Authorization', token);
    const coldRes = await reqCold;
    const coldLatency = Date.now() - tColdStart;

    // Warm requests measurements
    const warmLatencies = [];
    for (let i = 0; i < WARM_ITERATIONS; i++) {
      const tWarmStart = Date.now();
      let reqWarm = request(app).get(ep.path);
      if (ep.auth) reqWarm = reqWarm.set('Authorization', token);
      await reqWarm;
      warmLatencies.push(Date.now() - tWarmStart);
    }

    const stats = calculatePercentiles(warmLatencies);
    benchmarkResults.push({
      endpoint: ep.name,
      path: ep.path,
      statusCode: coldRes.status,
      coldMs: coldLatency,
      warmMinMs: stats.min,
      warmAvgMs: stats.avg,
      p50Ms: stats.p50,
      p95Ms: stats.p95,
      p99Ms: stats.p99,
    });

    console.log(`Cold: ${coldLatency}ms | Warm p50: ${stats.p50}ms | p95: ${stats.p95}ms | p99: ${stats.p99}ms`);
  }

  console.log('\n================================================================');
  console.log('FINAL BENCHMARK SUMMARY TABLE:');
  console.log('================================================================');
  console.table(benchmarkResults);

  await pool.end();
}

runBenchmark().catch((err) => {
  console.error('Benchmark execution error:', err);
  process.exit(1);
});
