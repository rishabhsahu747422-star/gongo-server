'use strict';

const crypto = require('crypto');

/**
 * Executes a raw HTTP request against the test server.
 *
 * @param {string} url
 * @param {object} options
 * @returns {Promise<{ status: number, body: any, headers: object }>}
 */
async function fetchHttp(url, options = {}) {
  const method = options.method || 'GET';
  const headers = options.headers || {};
  const { body } = options;

  const res = await fetch(url, {
    method,
    headers,
    body,
  });

  let responseBody;
  const text = await res.text();
  try {
    responseBody = JSON.parse(text);
  } catch {
    responseBody = text;
  }

  return {
    status: res.status,
    body: responseBody,
    headers: Object.fromEntries(res.headers.entries()),
  };
}

/**
 * Runs the 5 production concurrency scenarios.
 *
 * @param {object} serverInstance
 * @returns {Promise<object>}
 */
async function runConcurrencyScenarios(serverInstance) {
  const {
    baseUrl,
    createCustomer,
    bikeVehicleId,
    carVehicleId,
    shopId,
    bikeCategoryId,
    signPayload,
    db,
  } = serverInstance;

  const results = {};

  // ════════════════════════════════════════════════════════════════════
  // Scenario 1: Same Vehicle Contention (Overlapping Interval)
  // ════════════════════════════════════════════════════════════════════
  {
    const CONCURRENT_REQUESTS = 20;
    const startAt = new Date(Date.now() + 86400000 * 20).toISOString();
    const endAt = new Date(Date.now() + 86400000 * 22).toISOString();

    const customers = Array.from({ length: CONCURRENT_REQUESTS }, () => (
      createCustomer()
    ));

    const promises = customers.map((c) => (
      fetchHttp(`${baseUrl}/api/v1/bookings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: c.token,
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
      })
    ));

    const responses = await Promise.all(promises);

    const successCount = responses.filter((r) => r.status === 201).length;
    const conflictCount = responses.filter((r) => r.status === 409).length;
    const otherCount = responses.filter((r) => r.status !== 201 && r.status !== 409).length;

    // Verify database booking count for this interval
    const dbBookings = db.public.many(`
      SELECT id, status FROM bookings
      WHERE vehicle_id = '${bikeVehicleId}'
        AND start_at = '${startAt}'
        AND status != 'CANCELLED'
    `);

    results.scenario1 = {
      name: 'Same Vehicle Contention',
      totalRequests: CONCURRENT_REQUESTS,
      successCount,
      conflictCount,
      otherCount,
      dbBookingCount: dbBookings.length,
      doubleBookingPrevented: successCount === 1 && dbBookings.length === 1,
      passed: successCount === 1 && conflictCount === (CONCURRENT_REQUESTS - 1) && otherCount === 0,
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // Scenario 2: Different Vehicles (Parallel Non-Contended Bookings)
  // ════════════════════════════════════════════════════════════════════
  {
    const VEHICLE_COUNT = 10;
    const vehicleIds = [];

    for (let i = 0; i < VEHICLE_COUNT; i += 1) {
      const vId = crypto.randomUUID();
      vehicleIds.push(vId);
      db.public.none(`
        INSERT INTO vehicles (
          id, shop_id, category_id, brand, model, vehicle_name,
          year, fuel_type, transmission, seats, price_per_day,
          security_deposit, late_fee_per_hour, extra_km_charge, listing_status
        ) VALUES (
          '${vId}', '${shopId}', '${bikeCategoryId}', 'Honda', 'Activa-${i}',
          'Activa Unit ${i}', 2024, 'PETROL', 'AUTOMATIC', 2, 500.00,
          1000.00, 100.00, 8.00, 'ACTIVE'
        );
      `);
    }

    const startAt = new Date(Date.now() + 86400000 * 30).toISOString();
    const endAt = new Date(Date.now() + 86400000 * 32).toISOString();

    const customers = Array.from({ length: VEHICLE_COUNT }, () => createCustomer());

    const promises = vehicleIds.map((vId, idx) => (
      fetchHttp(`${baseUrl}/api/v1/bookings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: customers[idx].token,
        },
        body: JSON.stringify({
          vehicleId: vId,
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
      })
    ));

    const responses = await Promise.all(promises);

    const successCount = responses.filter((r) => r.status === 201).length;
    const failCount = responses.filter((r) => r.status !== 201).length;

    results.scenario2 = {
      name: 'Different Vehicles Concurrency',
      totalRequests: VEHICLE_COUNT,
      successCount,
      failCount,
      passed: successCount === VEHICLE_COUNT && failCount === 0,
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // Scenario 3: Limited Coupon Contention
  // ════════════════════════════════════════════════════════════════════
  {
    const couponId = crypto.randomUUID();
    const couponCode = `LIMIT${Date.now().toString().slice(-4)}`;
    const USAGE_LIMIT = 3;
    const CONCURRENT_CUSTOMERS = 15;

    db.public.none(`
      INSERT INTO coupons (
        id, code, discount_type, discount_value, min_booking_amount,
        max_discount_amount, usage_limit, per_customer_limit,
        valid_from, valid_until, is_active
      ) VALUES (
        '${couponId}', '${couponCode}', 'FIXED', 100.00, 200.00,
        100.00, ${USAGE_LIMIT}, 1,
        NOW() - INTERVAL '1 day', NOW() + INTERVAL '30 days', true
      );
    `);

    // Create unique vehicles for each booking to isolate coupon contention from vehicle contention
    const couponVehicles = [];
    for (let i = 0; i < CONCURRENT_CUSTOMERS; i += 1) {
      const vId = crypto.randomUUID();
      couponVehicles.push(vId);
      db.public.none(`
        INSERT INTO vehicles (
          id, shop_id, category_id, brand, model, vehicle_name,
          year, fuel_type, transmission, seats, price_per_day,
          security_deposit, late_fee_per_hour, extra_km_charge, listing_status
        ) VALUES (
          '${vId}', '${shopId}', '${bikeCategoryId}', 'Honda', 'Model-${i}',
          'Bike ${i}', 2024, 'PETROL', 'AUTOMATIC', 2, 500.00,
          1000.00, 100.00, 8.00, 'ACTIVE'
        );
      `);
    }

    const customers = Array.from({ length: CONCURRENT_CUSTOMERS }, () => createCustomer());
    const startAt = new Date(Date.now() + 86400000 * 40).toISOString();
    const endAt = new Date(Date.now() + 86400000 * 42).toISOString();

    const promises = customers.map((c, idx) => (
      fetchHttp(`${baseUrl}/api/v1/bookings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: c.token,
        },
        body: JSON.stringify({
          vehicleId: couponVehicles[idx],
          rentalType: 'DAILY',
          startAt,
          endAt,
          couponCode,
          pricingSnapshot: {
            pricePerDay: 500.00,
            baseAmount: 1000.00,
            discountAmount: 100.00,
            couponId,
            couponCode,
            securityDeposit: 1000.00,
            lateFeePerHour: 100.00,
            extraKmCharge: 8.00,
            totalAmount: 1900.00,
          },
        }),
      })
    ));

    const responses = await Promise.all(promises);

    const successCount = responses.filter((r) => r.status === 201).length;
    const limitExceededCount = responses.filter((r) => (
      r.status === 400 && r.body && (
        r.body.code === 'COUPON_USAGE_LIMIT_REACHED'
        || r.body.code === 'COUPON_USAGE_LIMIT_EXCEEDED'
      )
    )).length;

    // Verify database redemptions count
    const redemptions = db.public.many(`
      SELECT id FROM coupon_redemptions WHERE coupon_id = '${couponId}'
    `);

    results.scenario3 = {
      name: 'Limited Coupon Contention',
      usageLimit: USAGE_LIMIT,
      totalRequests: CONCURRENT_CUSTOMERS,
      successCount,
      limitExceededCount,
      dbRedemptionCount: redemptions.length,
      limitRespected: redemptions.length <= USAGE_LIMIT,
      passed: successCount === USAGE_LIMIT
        && redemptions.length === USAGE_LIMIT
        && limitExceededCount === (CONCURRENT_CUSTOMERS - USAGE_LIMIT),
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // Scenario 4: Payment Idempotency (Concurrent Identical Requests)
  // ════════════════════════════════════════════════════════════════════
  {
    const customer = createCustomer();
    const bookingId = crypto.randomUUID();

    db.public.none(`
      INSERT INTO bookings (
        id, customer_id, vehicle_id, rental_type, start_at, end_at,
        status, base_amount, total_amount, security_deposit
      ) VALUES (
        '${bookingId}', '${customer.userId}', '${carVehicleId}', 'DAILY',
        NOW() + INTERVAL '50 days', NOW() + INTERVAL '52 days',
        'PENDING', 1000.00, 2000.00, 1000.00
      );
    `);

    const IDEMPOTENCY_KEY = `idem_key_${Date.now()}`;
    const CONCURRENT_REQUESTS = 10;

    const promises = Array.from({ length: CONCURRENT_REQUESTS }, () => (
      fetchHttp(`${baseUrl}/api/v1/bookings/${bookingId}/payment`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: customer.token,
          'x-idempotency-key': IDEMPOTENCY_KEY,
        },
      })
    ));

    const responses = await Promise.all(promises);

    const status200Count = responses.filter((r) => r.status === 200 || r.status === 201).length;
    const orderIds = new Set(
      responses.map((r) => (
        r.body?.data?.payment?.providerOrderId
        || r.body?.data?.payment?.id
        || r.body?.data?.orderId
      )).filter(Boolean),
    );

    // Check payment records in DB
    const dbPayments = db.public.many(`
      SELECT id, provider_order_id FROM payments WHERE booking_id = '${bookingId}'
    `);

    results.scenario4 = {
      name: 'Payment Idempotency',
      totalRequests: CONCURRENT_REQUESTS,
      status200Count,
      distinctOrderIdsReturned: orderIds.size,
      dbPaymentRecordCount: dbPayments.length,
      passed: status200Count === CONCURRENT_REQUESTS
        && orderIds.size === 1
        && dbPayments.length === 1,
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // Scenario 5: Duplicate / Concurrent Webhook Callbacks
  // ════════════════════════════════════════════════════════════════════
  {
    const customer = createCustomer();
    const bookingId = crypto.randomUUID();
    const orderId = `cf_order_webhook_${Date.now()}`;

    db.public.none(`
      INSERT INTO bookings (
        id, customer_id, vehicle_id, rental_type, start_at, end_at,
        status, base_amount, total_amount, security_deposit
      ) VALUES (
        '${bookingId}', '${customer.userId}', '${carVehicleId}', 'DAILY',
        NOW() + INTERVAL '60 days', NOW() + INTERVAL '62 days',
        'PAYMENT_PENDING', 1000.00, 2000.00, 1000.00
      );

      INSERT INTO payments (
        id, booking_id, customer_id, provider, provider_order_id,
        amount, currency, status
      ) VALUES (
        '${crypto.randomUUID()}', '${bookingId}', '${customer.userId}',
        'CASHFREE', '${orderId}', 2000.00, 'INR', 'CREATED'
      );
    `);

    const webhookPayload = JSON.stringify({
      data: {
        order: {
          order_id: orderId,
          order_amount: 2000.00,
          order_currency: 'INR',
        },
        payment: {
          cf_payment_id: `cf_pay_${Date.now()}`,
          payment_status: 'SUCCESS',
          payment_amount: 2000.00,
          payment_currency: 'INR',
          payment_message: 'Success',
          payment_time: new Date().toISOString(),
        },
      },
      event_time: new Date().toISOString(),
      type: 'PAYMENT_SUCCESS_WEBHOOK',
    });

    const headers = signPayload(webhookPayload);
    const CONCURRENT_WEBHOOKS = 10;

    const promises = Array.from({ length: CONCURRENT_WEBHOOKS }, () => (
      fetchHttp(`${baseUrl}/api/v1/payments/webhook/cashfree`, {
        method: 'POST',
        headers,
        body: webhookPayload,
      })
    ));

    const responses = await Promise.all(promises);

    const successResponses = responses.filter((r) => r.status === 200).length;

    // Check payment state in DB
    const finalPayment = db.public.one(`
      SELECT status FROM payments WHERE provider_order_id = '${orderId}'
    `);

    const finalBooking = db.public.one(`
      SELECT status FROM bookings WHERE id = '${bookingId}'
    `);

    results.scenario5 = {
      name: 'Duplicate Webhook Replay',
      totalRequests: CONCURRENT_WEBHOOKS,
      successResponses,
      finalPaymentStatus: finalPayment.status,
      finalBookingStatus: finalBooking.status,
      // Raw DB values: PAYMENT_STATUS.SUCCESS = 'paid' (src/constants/payment.js);
      // webhook success writes bookings.status = 'payment_completed' (BOOKING_STATUS.PAYMENT_COMPLETED).
      passed: successResponses === CONCURRENT_WEBHOOKS
        && finalPayment.status === 'paid'
        && finalBooking.status === 'payment_completed',
    };
  }

  return results;
}

module.exports = {
  runConcurrencyScenarios,
  fetchHttp,
};
