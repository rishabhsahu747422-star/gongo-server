const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');
const { Pool } = require('pg');

async function testHost(hostname, port) {
  console.log(`\n--- Testing ${hostname}:${port} ---`);
  
  // 1. DNS Lookup
  const tDns0 = Date.now();
  const addresses = await dns.lookup(hostname, { all: true });
  console.log(`DNS Lookup: ${Date.now() - tDns0}ms ->`, addresses.map(a => a.address));

  // 2. TCP Connect
  const tTcp0 = Date.now();
  await new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: hostname, port }, () => {
      sock.end();
      resolve();
    });
    sock.on('error', reject);
    sock.setTimeout(10000, () => {
      sock.destroy();
      reject(new Error('TCP timeout'));
    });
  });
  console.log(`TCP Connect: ${Date.now() - tTcp0}ms`);
}

async function testPool(url, name) {
  console.log(`\n--- Testing PG Pool with ${name} ---`);
  const pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });

  try {
    const t0 = Date.now();
    const client = await pool.connect();
    console.log(`Pool connect: ${Date.now() - t0}ms`);

    const t1 = Date.now();
    await client.query('SELECT 1');
    console.log(`Query 1 (SELECT 1): ${Date.now() - t1}ms`);

    const t2 = Date.now();
    await client.query('SELECT 1');
    console.log(`Query 2 (SELECT 1): ${Date.now() - t2}ms`);

    const t3 = Date.now();
    await client.query('SELECT 1');
    console.log(`Query 3 (SELECT 1): ${Date.now() - t3}ms`);

    client.release();
  } catch (err) {
    console.error(`PG Pool error for ${name}:`, err.message);
  } finally {
    await pool.end();
  }
}

async function run() {
  await testHost('aws-0-ap-southeast-2.pooler.supabase.com', 5432);
  await testHost('db.mtfljykvxyslhdvpfcil.supabase.co', 5432);
  await testHost('aws-0-ap-southeast-2.pooler.supabase.com', 6543);

  const urlPooler = 'postgresql://postgres.mtfljykvxyslhdvpfcil:Harshu%40898923@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres';
  const urlDirect = 'postgresql://postgres:Harshu%40898923@db.mtfljykvxyslhdvpfcil.supabase.co:5432/postgres';
  const urlTransactionPooler = 'postgresql://postgres.mtfljykvxyslhdvpfcil:Harshu%40898923@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres';

  await testPool(urlPooler, 'Supabase Pooler Port 5432 (Current .env)');
  await testPool(urlDirect, 'Supabase Direct db.mtfljykvxyslhdvpfcil.supabase.co:5432');
  await testPool(urlTransactionPooler, 'Supabase Pooler Port 6543 (Transaction Mode)');
}

run();
