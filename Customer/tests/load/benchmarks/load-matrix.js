'use strict';

const autocannon = require('autocannon');

/**
 * Runs autocannon against an endpoint and extracts standard performance metrics.
 *
 * @param {object} opts - Autocannon configuration options
 * @returns {Promise<{
 *   endpoint: string,
 *   method: string,
 *   requestsPerSec: number,
 *   p50: number,
 *   p90: number,
 *   p95: number,
 *   p99: number,
 *   avgLatency: number,
 *   totalRequests: number,
 *   errors: number,
 *   timeouts: number,
 *   non2xx: number,
 *   status2xx: number,
 *   status4xx: number,
 *   status5xx: number
 * }>}
 */
async function runBenchmark(opts) {
  const result = await autocannon({
    connections: opts.connections || 10,
    duration: opts.duration || 3,
    pipelining: 1,
    ...opts,
  });

  const p95 = result.latency.p97_5 || result.latency.p90 || result.latency.average;

  return {
    name: opts.name || opts.url,
    endpoint: opts.url.replace(/^http:\/\/[^/]+/, ''),
    method: opts.method || 'GET',
    requestsPerSec: Math.round(result.requests.average * 10) / 10,
    p50: result.latency.p50,
    p90: result.latency.p90,
    p95,
    p99: result.latency.p99,
    avgLatency: Math.round(result.latency.average * 10) / 10,
    totalRequests: result.requests.total,
    errors: result.errors,
    timeouts: result.timeouts,
    non2xx: result.non2xx,
    status2xx: result['2xx'] || 0,
    status4xx: result['4xx'] || 0,
    status5xx: result['5xx'] || 0,
  };
}

/**
 * Executes the complete API performance test matrix across all 10 core domains.
 *
 * @param {object} serverInstance - Running load test server instance
 * @param {object} [config] - Optional duration/connections config
 * @returns {Promise<Array<object>>}
 */
async function executeLoadMatrix(serverInstance, config = {}) {
  const {
    baseUrl,
    createCustomer,
    bikeVehicleId,
    carVehicleId,
    signPayload,
    db,
  } = serverInstance;

  const duration = config.duration || 2;
  const connections = config.connections || 5;

  const customer = createCustomer({ name: 'Load Benchmark Customer' });
  const authHeaders = {
    'content-type': 'application/json',
    authorization: customer.token,
  };

  // Pre-seed an address for profile/address reads
  const addressId = '11111111-2222-4333-8444-555555555555';
  db.public.none(`
    INSERT INTO customer_addresses (id, user_id, label, full_address, city, state, postal_code, is_default)
    VALUES ('${addressId}', '${customer.userId}', 'HOME', '100 Feet Rd, Indiranagar', 'Bengaluru', 'Karnataka', '560038', true);
  `);

  // Pre-seed a booking for payment / details reads
  const bookingId = '22222222-3333-4444-8555-666666666666';
  db.public.none(`
    INSERT INTO bookings (
      id, customer_id, vehicle_id, rental_type, start_at, end_at,
      status, base_amount, total_amount, security_deposit
    ) VALUES (
      '${bookingId}', '${customer.userId}', '${carVehicleId}', 'HOURLY',
      NOW() + INTERVAL '10 days', NOW() + INTERVAL '10 days 4 hours',
      'PENDING', 600.00, 3600.00, 3000.00
    );
  `);

  // Pre-seed notifications
  db.public.none(`
    INSERT INTO notifications (id, customer_id, type, title, body, status)
    VALUES
      ('33333333-4444-4555-8666-777777777777', '${customer.userId}', 'BOOKING_CREATED', 'Booking Confirmed', 'Details...', 'SENT'),
      ('44444444-5555-4666-8777-888888888888', '${customer.userId}', 'PAYMENT_SUCCESS', 'Payment Received', 'Details...', 'SENT');
  `);

  // Pre-seed a support ticket
  const ticketId = '55555555-6666-4777-8888-999999999999';
  db.public.none(`
    INSERT INTO support_tickets (id, customer_id, ticket_number, category, subject, status)
    VALUES ('${ticketId}', '${customer.userId}', 'TKT-20260919-0001', 'BOOKING', 'Need help with pickup', 'OPEN');
  `);

  const results = [];

  // ── A. Authentication ──────────────────────────────────────────
  results.push(await runBenchmark({
    name: 'Auth: Token Verification Path',
    url: `${baseUrl}/api/v1/me`,
    method: 'GET',
    headers: authHeaders,
    duration,
    connections,
  }));

  // ── B. Customer / Profile ──────────────────────────────────────
  results.push(await runBenchmark({
    name: 'Customer: GET Profile',
    url: `${baseUrl}/api/v1/me`,
    method: 'GET',
    headers: authHeaders,
    duration,
    connections,
  }));

  results.push(await runBenchmark({
    name: 'Customer: GET Saved Addresses',
    url: `${baseUrl}/api/v1/me/addresses`,
    method: 'GET',
    headers: authHeaders,
    duration,
    connections,
  }));

  // ── C. Location ────────────────────────────────────────────────
  results.push(await runBenchmark({
    name: 'Location: GET Cities',
    url: `${baseUrl}/api/v1/vehicles/cities`,
    method: 'GET',
    duration,
    connections,
  }));

  // ── D. Vehicle Discovery (Read-Heavy) ──────────────────────────
  results.push(await runBenchmark({
    name: 'Vehicles: Unfiltered Listing',
    url: `${baseUrl}/api/v1/vehicles`,
    method: 'GET',
    duration,
    connections,
  }));

  results.push(await runBenchmark({
    name: 'Vehicles: Filtered (Category + Sort)',
    url: `${baseUrl}/api/v1/vehicles?category=bike&sort=price_low_high&page=1&limit=10`,
    method: 'GET',
    duration,
    connections,
  }));

  results.push(await runBenchmark({
    name: 'Vehicles: Categories Lookup',
    url: `${baseUrl}/api/v1/vehicles/categories`,
    method: 'GET',
    duration,
    connections,
  }));

  results.push(await runBenchmark({
    name: 'Vehicles: Vehicle Details',
    url: `${baseUrl}/api/v1/vehicles/${bikeVehicleId}`,
    method: 'GET',
    duration,
    connections,
  }));

  // ── E. Pricing & Coupons ───────────────────────────────────────
  const startAt = new Date(Date.now() + 86400000 * 2).toISOString();
  const endAt = new Date(Date.now() + 86400000 * 4).toISOString();

  results.push(await runBenchmark({
    name: 'Pricing: Quote Calculation',
    url: `${baseUrl}/api/v1/pricing/quote`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      vehicleId: bikeVehicleId,
      startAt,
      endAt,
    }),
    duration,
    connections,
  }));

  results.push(await runBenchmark({
    name: 'Pricing: Quote with Valid Coupon (GONGO100)',
    url: `${baseUrl}/api/v1/pricing/quote`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      vehicleId: bikeVehicleId,
      startAt,
      endAt,
      couponCode: 'GONGO100',
    }),
    duration,
    connections,
  }));

  // ── F. Booking & Availability ──────────────────────────────────
  const availUrl = `${baseUrl}/api/v1/bookings/availability`
    + `?vehicleId=${bikeVehicleId}`
    + `&startAt=${encodeURIComponent(startAt)}`
    + `&endAt=${encodeURIComponent(endAt)}`;

  results.push(await runBenchmark({
    name: 'Booking: Availability Check',
    url: availUrl,
    method: 'GET',
    headers: authHeaders,
    duration,
    connections,
  }));

  results.push(await runBenchmark({
    name: 'Booking: GET Booking Details',
    url: `${baseUrl}/api/v1/bookings/${bookingId}`,
    method: 'GET',
    headers: authHeaders,
    duration,
    connections,
  }));

  // ── H. Payment & Webhook ───────────────────────────────────────
  const webhookBody = JSON.stringify({
    data: {
      order: {
        order_id: `cf_order_${bookingId}`,
        order_amount: 3600.00,
        order_currency: 'INR',
      },
      payment: {
        cf_payment_id: 'cf_pay_test_999999',
        payment_status: 'SUCCESS',
        payment_amount: 3600.00,
        payment_currency: 'INR',
        payment_message: 'Paid successfully',
        payment_time: new Date().toISOString(),
      },
    },
    event_time: new Date().toISOString(),
    type: 'PAYMENT_SUCCESS_WEBHOOK',
  });

  // Pre-seed a payment order in payments table
  const paymentOrderId = `cf_order_${bookingId}`;
  db.public.none(`
    INSERT INTO payments (
      id, booking_id, customer_id, provider, provider_order_id,
      amount, currency, status
    ) VALUES (
      '66666666-7777-4888-8999-000000000000', '${bookingId}', '${customer.userId}',
      'CASHFREE', '${paymentOrderId}', 3600.00, 'INR', 'CREATED'
    ) ON CONFLICT (provider_order_id) DO NOTHING;
  `);

  const webhookHeaders = signPayload(webhookBody);

  results.push(await runBenchmark({
    name: 'Payment: Cashfree Webhook Processing',
    url: `${baseUrl}/api/v1/payments/webhook/cashfree`,
    method: 'POST',
    headers: webhookHeaders,
    body: webhookBody,
    duration,
    connections,
  }));

  // ── I. Notifications ───────────────────────────────────────────
  results.push(await runBenchmark({
    name: 'Notifications: Listing',
    url: `${baseUrl}/api/v1/me/notifications`,
    method: 'GET',
    headers: authHeaders,
    duration,
    connections,
  }));

  results.push(await runBenchmark({
    name: 'Notifications: Unread Count',
    url: `${baseUrl}/api/v1/me/notifications/unread-count`,
    method: 'GET',
    headers: authHeaders,
    duration,
    connections,
  }));

  // ── J. Support ─────────────────────────────────────────────────
  results.push(await runBenchmark({
    name: 'Support: Ticket Listing',
    url: `${baseUrl}/api/v1/me/support/tickets`,
    method: 'GET',
    headers: authHeaders,
    duration,
    connections,
  }));

  results.push(await runBenchmark({
    name: 'Support: Ticket Details & History',
    url: `${baseUrl}/api/v1/me/support/tickets/${ticketId}`,
    method: 'GET',
    headers: authHeaders,
    duration,
    connections,
  }));

  // ── K. Request Size & Abuse Protections ─────────────────────────
  const oversizedPayload = JSON.stringify({
    payload: 'X'.repeat(12 * 1024), // 12kb > 10kb limit
  });

  results.push(await runBenchmark({
    name: 'Abuse: Oversized Payload Rejection (>10kb)',
    url: `${baseUrl}/api/v1/pricing/quote`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: oversizedPayload,
    duration,
    connections,
  }));

  results.push(await runBenchmark({
    name: 'Abuse: Malformed JSON Rejection',
    url: `${baseUrl}/api/v1/pricing/quote`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"invalid_json": true, missing_brace',
    duration,
    connections,
  }));

  return results;
}

module.exports = {
  runBenchmark,
  executeLoadMatrix,
};
