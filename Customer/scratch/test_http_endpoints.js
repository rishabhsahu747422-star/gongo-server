require('dotenv').config();
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function main() {
  try {
    // 1. Get customer
    const uRes = await pool.query("SELECT id, role, phone, email FROM users WHERE role = 'customer' ORDER BY created_at DESC LIMIT 1");
    const customer = uRes.rows[0];
    console.log('Using customer:', customer);

    // 2. Get active vehicle
    const vRes = await pool.query("SELECT id, brand, model FROM vehicles WHERE model ILIKE '%Activa%' AND status = 'active' LIMIT 1");
    const vehicle = vRes.rows[0];
    console.log('Using vehicle:', vehicle);

    // 3. Generate test JWT token
    const token = jwt.sign(
      {
        sub: customer.id,
        id: customer.id,
        role: 'customer',
        email: customer.email || 'customer@example.com',
      },
      process.env.JWT_SECRET || 'your-default-jwt-secret-key-change-in-production-min-32-chars',
      { expiresIn: '1h' }
    );

    const client = axios.create({
      baseURL: 'http://192.168.229.84:3000/api/v1',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    console.log('\n--- TEST 1: POST /api/v1/bookings with isDevPayment = true ---');
    const startAt = new Date(Date.now() + 86400000 * 2).toISOString();
    const endAt = new Date(Date.now() + 86400000 * 6).toISOString();

    const bookingRes = await client.post('/bookings', {
      vehicleId: vehicle.id,
      rentalType: 'DAILY',
      startAt,
      endAt,
      isDevPayment: true,
    }, {
      headers: {
        'Idempotency-Key': `http-test-${Date.now()}`,
        'X-Dev-Payment': 'true',
      },
    });

    console.log('Booking creation response status:', bookingRes.status);
    console.log('Booking response data:', {
      success: bookingRes.data.success,
      bookingId: bookingRes.data.data?.booking?.id,
      bookingStatus: bookingRes.data.data?.booking?.bookingStatus,
      paymentStatus: bookingRes.data.data?.booking?.paymentStatus,
      payment: bookingRes.data.data?.booking?.payment,
    });

    console.log('\n--- TEST 2: POST /api/v1/payments/dev-bypass on existing booking ---');
    // Create a regular pending booking first
    const startAt2 = new Date(Date.now() + 86400000 * 7).toISOString();
    const endAt2 = new Date(Date.now() + 86400000 * 10).toISOString();
    const pendingBookingRes = await client.post('/bookings', {
      vehicleId: vehicle.id,
      rentalType: 'DAILY',
      startAt: startAt2,
      endAt: endAt2,
    }, {
      headers: {
        'Idempotency-Key': `http-test-pending-${Date.now()}`,
      },
    });

    const pendingBookingId = pendingBookingRes.data.data?.booking?.id;
    console.log('Created pending booking ID:', pendingBookingId);

    const bypassRes = await client.post('/payments/dev-bypass', {
      bookingId: pendingBookingId,
    });

    console.log('Dev bypass response status:', bypassRes.status);
    console.log('Dev bypass response data:', {
      success: bypassRes.data.success,
      bookingId: bypassRes.data.data?.booking?.id,
      bookingStatus: bypassRes.data.data?.booking?.bookingStatus,
      paymentStatus: bypassRes.data.data?.booking?.paymentStatus,
    });

    console.log('\nALL HTTP ENDPOINT TESTS PASSED CLEANLY! 🎉');
  } catch (err) {
    console.error('HTTP TEST FAILED:');
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', err.response.data);
    } else {
      console.error(err.message);
    }
  } finally {
    await pool.end();
  }
}

main();
