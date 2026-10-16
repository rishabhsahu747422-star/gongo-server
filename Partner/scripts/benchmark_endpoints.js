'use strict';
require('dotenv').config();
const http = require('http');

const TOKEN = 'Bearer dev-partner-token';
const BASE_URL = 'http://localhost:3001';

function makeRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': TOKEN,
        'Content-Type': 'application/json',
      },
    };

    const t0 = Date.now();
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const duration = Date.now() - t0;
        resolve({
          status: res.statusCode,
          duration,
          data: data ? JSON.parse(data) : null,
        });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function benchmark() {
  console.log('======================================================================');
  console.log('LIVE ENDPOINT BENCHMARK — GONGO PARTNER BACKEND');
  console.log('======================================================================');

  const endpoints = [
    { label: 'Health Check', path: '/api/v1/health' },
    { label: 'Dashboard Stats', path: '/api/v1/partner/dashboard/stats' },
    { label: 'Wallet Summary', path: '/api/v1/partner/wallet' },
    { label: 'Wallet Transactions', path: '/api/v1/partner/wallet/transactions' },
    { label: 'Vehicles List (limit=100)', path: '/api/v1/partner/vehicles?limit=100' },
    { label: 'Bookings List (limit=100)', path: '/api/v1/partner/bookings?limit=100' },
    { label: 'Earnings Summary', path: '/api/v1/partner/earnings/summary' },
    { label: 'Earnings Paginated', path: '/api/v1/partner/earnings?page=1&limit=15' },
    { label: 'Bank Accounts', path: '/api/v1/partner/bank-account' },
  ];

  // Warmup run
  console.log('--- WARMUP RUN ---');
  for (const ep of endpoints) {
    try {
      const res = await makeRequest(ep.path);
      console.log(`[WARMUP] ${ep.label.padEnd(30)}: ${res.duration}ms (status ${res.status})`);
    } catch (err) {
      console.error(`Error warming ${ep.path}:`, err.message);
    }
  }

  // Measured run
  console.log('\n--- MEASURED RUN (WARM SOCKET & CACHED AUTH) ---');
  for (const ep of endpoints) {
    try {
      const res = await makeRequest(ep.path);
      console.log(`[BENCHMARK] ${ep.label.padEnd(30)}: ${res.duration}ms (status ${res.status})`);
    } catch (err) {
      console.error(`Error measuring ${ep.path}:`, err.message);
    }
  }

  // Second measured run
  console.log('\n--- VERIFICATION RUN (REPEAT TO CONFIRM CONSISTENCY) ---');
  for (const ep of endpoints) {
    try {
      const res = await makeRequest(ep.path);
      console.log(`[VERIFY]    ${ep.label.padEnd(30)}: ${res.duration}ms (status ${res.status})`);
    } catch (err) {
      console.error(`Error verifying ${ep.path}:`, err.message);
    }
  }
}

benchmark().catch(err => {
  console.error(err);
  process.exit(1);
});
