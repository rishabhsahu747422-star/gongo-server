require('dotenv').config();
const { pool } = require('../src/db/pool');

async function measure() {
  console.log('=== NETWORK & POOL LATENCY PROBE ===');

  // Test 1: Direct pool.query latency (5 samples)
  const queryLatencies = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    await pool.query('SELECT 1');
    queryLatencies.push(Date.now() - t0);
  }
  console.log('SELECT 1 latencies (ms):', queryLatencies);
  console.log('Average SELECT 1 round-trip latency:', Math.round(queryLatencies.reduce((a, b) => a + b, 0) / queryLatencies.length), 'ms');

  // Test 2: Connection acquisition latency (checkout from pool)
  const connectLatencies = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    const client = await pool.connect();
    connectLatencies.push(Date.now() - t0);
    client.release();
  }
  console.log('pool.connect() checkout latencies (ms):', connectLatencies);

  // Test 3: Pool stats
  console.log('Pool total count:', pool.totalCount);
  console.log('Pool idle count:', pool.idleCount);
  console.log('Pool waiting count:', pool.waitingCount);

  // Test 4: Auth lookup query timing
  const tAuth0 = Date.now();
  const authRes = await pool.query(
    'SELECT p.id, p.user_id, u.auth_id FROM users u LEFT JOIN partners p ON p.user_id = u.id WHERE u.auth_id = $1 LIMIT 1',
    ['dev-partner-auth-id']
  );
  const authTime = Date.now() - tAuth0;
  console.log('Auth lookup query duration:', authTime, 'ms, rows:', authRes.rows.length);

  await pool.end();
}

measure().catch(err => {
  console.error(err);
  process.exit(1);
});
