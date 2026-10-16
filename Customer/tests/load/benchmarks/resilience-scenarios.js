'use strict';

const crypto = require('crypto');
const firebaseProvider = require('../../../src/services/notification/providers/firebase.provider');
const cashfreeProvider = require('../../../src/services/payment/providers/cashfree.provider');
const { fetchHttp } = require('./concurrency-scenarios');

/**
 * Runs failure, recovery, and resilience tests under load.
 *
 * @param {object} serverInstance
 * @returns {Promise<object>}
 */
async function runResilienceScenarios(serverInstance) {
  const {
    baseUrl,
    createCustomer,
    bikeVehicleId,
    carVehicleId,
    db,
  } = serverInstance;

  const results = {};

  // ════════════════════════════════════════════════════════════════════
  // 1. Notification Provider (FCM) Network Failure Resilience
  // ════════════════════════════════════════════════════════════════════
  {
    // Simulate FCM throwing network failure
    firebaseProvider.setMockDelegate({
      sendMulticast: async () => {
        throw new Error('Simulated FCM Network Timeout');
      },
    });

    const customer = createCustomer();
    const startAt = new Date(Date.now() + 86400000 * 70).toISOString();
    const endAt = new Date(Date.now() + 86400000 * 72).toISOString();

    // Booking creation triggers push notification dispatch
    const bookingRes = await fetchHttp(`${baseUrl}/api/v1/bookings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: customer.token,
      },
      body: JSON.stringify({
        vehicleId: bikeVehicleId,
        rentalType: 'DAILY',
        startAt,
        endAt,
        pricingSnapshot: {
          pricePerDay: 500.00,
          baseAmount: 1000.00,
          discountAmount: 0.00,
          securityDeposit: 1000.00,
          lateFeePerHour: 100.00,
          extraKmCharge: 8.00,
          totalAmount: 2000.00,
        },
      }),
    });

    // Restore working FCM delegate
    firebaseProvider.setMockDelegate({
      sendMulticast: async (payload) => ({
        successCount: payload.tokens.length,
        failureCount: 0,
        invalidTokens: [],
      }),
    });

    // Booking should still succeed (201 Created) because notification
    // failure must not fail the booking
    const bookingCreated = bookingRes.status === 201;

    results.fcmFailureResilience = {
      name: 'FCM Provider Failure Resilience',
      bookingStatus: bookingRes.status,
      bookingSucceeded: bookingCreated,
      passed: bookingCreated,
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // 2. Payment Gateway Provider (Cashfree) Failure Handling
  // ════════════════════════════════════════════════════════════════════
  {
    // Configure Cashfree delegate to simulate 503 Provider Error
    cashfreeProvider.setMockDelegate({
      createOrder: async () => {
        const err = new Error('Cashfree Gateway Unavailable');
        err.statusCode = 503;
        throw err;
      },
      getOrderStatus: async () => ({ orderStatus: 'ACTIVE' }),
    });

    const customer = createCustomer();
    const bookingId = crypto.randomUUID();

    db.public.none(`
      INSERT INTO bookings (
        id, customer_id, vehicle_id, rental_type, start_at, end_at,
        status, base_amount, total_amount, security_deposit
      ) VALUES (
        '${bookingId}', '${customer.userId}', '${carVehicleId}', 'DAILY',
        NOW() + INTERVAL '80 days', NOW() + INTERVAL '82 days',
        'PENDING', 1000.00, 2000.00, 1000.00
      );
    `);

    const paymentRes = await fetchHttp(`${baseUrl}/api/v1/bookings/${bookingId}/payment`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: customer.token,
      },
    });

    // Restore working Cashfree delegate
    cashfreeProvider.setMockDelegate({
      createOrder: async ({ orderId, orderAmount }) => ({
        providerOrderId: orderId,
        paymentSessionId: `cf_sess_${orderId}`,
        orderStatus: 'ACTIVE',
        cfOrderId: `cf_order_${orderId}`,
        orderAmount,
      }),
      getOrderStatus: async () => ({ orderStatus: 'ACTIVE' }),
    });

    // Check booking status in DB — must remain PENDING, not corrupted
    const bookingInDb = db.public.one(`
      SELECT status FROM bookings WHERE id = '${bookingId}'
    `);

    results.cashfreeFailureHandling = {
      name: 'Cashfree Gateway Failure Handling',
      httpStatus: paymentRes.status,
      bookingPreservedStatus: bookingInDb.status,
      passed: (paymentRes.status === 500 || paymentRes.status === 503)
        && bookingInDb.status === 'PENDING',
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // 3. Database Transaction Rollback & Connection Release
  // ════════════════════════════════════════════════════════════════════
  {
    const customer = createCustomer();
    const invalidBookingId = crypto.randomUUID();

    // Trigger an invalid update to ensure transaction rollbacks release cleanly
    const cancelRes = await fetchHttp(`${baseUrl}/api/v1/bookings/${invalidBookingId}/cancel`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: customer.token,
      },
      body: JSON.stringify({ reason: 'Test cancel' }),
    });

    // Subsequent valid query must execute immediately without connection starvation
    const probeRes = await fetchHttp(`${baseUrl}/api/v1/vehicles/categories`);

    results.dbConnectionRelease = {
      name: 'Database Transaction Rollback & Pool Release',
      errorStatus: cancelRes.status,
      subsequentProbeStatus: probeRes.status,
      passed: cancelRes.status === 404 && probeRes.status === 200,
    };
  }

  return results;
}

module.exports = {
  runResilienceScenarios,
};
