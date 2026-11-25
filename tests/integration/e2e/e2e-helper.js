'use strict';

const { newDb, DataType } = require('pg-mem');
const crypto = require('crypto');

const { pool } = require('../../../src/config/database');
const { setMockFirebaseAuth } = require('../../../src/config/firebase');
const { createApp } = require('../../../src/app');
const cashfreeProvider = require('../../../src/services/payment/providers/cashfree.provider');
const firebaseProvider = require('../../../src/services/notification/providers/firebase.provider');

// All migrations in chronological order
const usersMigration = require('../../../database/migrations/1726300000000_create-users-table');
const customerDocumentsMigration = require('../../../database/migrations/1726400000000_create-customer-documents-table');
const customerAddressesMigration = require('../../../database/migrations/1726500000000_create-customer-addresses-table');
const partnersShopsMigration = require('../../../database/migrations/1726600000000_create-partners-shops-table');
const categoriesCitiesMigration = require('../../../database/migrations/1726700000000_create-categories-cities-table');
const vehiclesMigration = require('../../../database/migrations/1726800000000_create-vehicles-table');
const vehicleImagesMigration = require('../../../database/migrations/1726900000000_create-vehicle-images-table');
const bookingsMigration = require('../../../database/migrations/1727000000000_create-bookings-table');
const idempotencyMigration = require('../../../database/migrations/1727100000000_create-idempotency-keys-table');
const couponsMigration = require('../../../database/migrations/1727200000000_create-coupons-table');
const addCouponColumnsMigration = require('../../../database/migrations/1727300000000_add-coupon-columns-to-bookings');
const paymentsMigration = require('../../../database/migrations/1727400000000_create-payments-table');
const deviceTokensMigration = require('../../../database/migrations/1727500000000_create-customer-device-tokens-table');
const notificationsMigration = require('../../../database/migrations/1727600000000_create-notifications-table');
const supportTicketsMigration = require('../../../database/migrations/1727700000000_create-support-tickets-table');
const supportMessagesMigration = require('../../../database/migrations/1727800000000_create-support-ticket-messages-table');
const addSupportReplyTypeMigration = require('../../../database/migrations/1727900000000_add-support-reply-notification-type');
const returnVerificationsMigration = require('../../../database/migrations/1728000000000_create-booking-return-verifications-table');
const addPaymentTypeMigration = require('../../../database/migrations/1728100000000_add-payment-type-to-payments');
const addAvatarMigration = require('../../../database/migrations/1728200000000_add-avatar-to-users');

const SECRET_KEY = process.env.CASHFREE_SECRET_KEY || 'test_cf_secret_key';

function signPayload(bodyString, timestamp = String(Date.now()), secret = SECRET_KEY) {
  const signature = crypto
    .createHmac('sha256', secret)
    .update(timestamp + bodyString)
    .digest('base64');

  return {
    'x-webhook-timestamp': timestamp,
    'x-webhook-signature': signature,
    'content-type': 'application/json',
  };
}

async function setupE2EEnvironment() {
  const db = newDb();

  db.registerExtension('pgcrypto', (schema) => {
    schema.registerFunction({
      name: 'gen_random_uuid',
      returns: DataType.uuid,
      impure: true,
      implementation: () => crypto.randomUUID(),
    });
  });

  const pgm = {
    sql: (statement) => {
      if (
        !statement.includes('LANGUAGE plpgsql')
        && !statement.includes('TRIGGER')
        && !statement.includes('btree_gist')
        && !statement.includes('EXCLUDE')
        && !statement.includes('DO $$')
      ) {
        db.public.none(statement);
      }
    },
  };

  await usersMigration.up(pgm);
  await customerDocumentsMigration.up(pgm);
  await customerAddressesMigration.up(pgm);
  await partnersShopsMigration.up(pgm);
  await categoriesCitiesMigration.up(pgm);
  await vehiclesMigration.up(pgm);
  await vehicleImagesMigration.up(pgm);
  await bookingsMigration.up(pgm);
  await idempotencyMigration.up(pgm);
  await couponsMigration.up(pgm);
  await addCouponColumnsMigration.up(pgm);
  await paymentsMigration.up(pgm);
  await deviceTokensMigration.up(pgm);
  await notificationsMigration.up(pgm);
  await supportTicketsMigration.up(pgm);
  await supportMessagesMigration.up(pgm);
  await addSupportReplyTypeMigration.up(pgm);
  await returnVerificationsMigration.up(pgm);
  await addPaymentTypeMigration.up(pgm);
  await addAvatarMigration.up(pgm);

  // Mock Firebase Auth
  const mockFirebaseAuth = {
    createCustomToken: jest.fn().mockImplementation(async (uid, claims = {}) => (
      `mock-token-${claims.gongoUserId || uid}`
    )),
    verifyIdToken: jest.fn().mockImplementation(async (token) => {
      if (token.startsWith('mock-token-')) {
        const gongoUserId = token.replace('mock-token-', '');
        const row = db.public.one(`SELECT * FROM users WHERE id = '${gongoUserId}'`);
        return {
          uid: row.auth_id,
          gongoUserId: row.id,
          auth_time: Math.floor(Date.now() / 1000) - 60,
          role: row.role || 'customer',
        };
      }
      if (token === 'token-partner') {
        return {
          uid: 'auth-partner-e2e',
          auth_time: Math.floor(Date.now() / 1000),
          role: 'partner',
        };
      }
      const err = new Error('Invalid token');
      err.code = 'auth/argument-error';
      throw err;
    }),
    revokeRefreshTokens: jest.fn().mockResolvedValue(undefined),
  };
  setMockFirebaseAuth(mockFirebaseAuth);

  // Mock Cashfree Provider
  cashfreeProvider.setMockDelegate({
    createOrder: jest.fn().mockImplementation(async ({ orderId, orderAmount }) => ({
      providerOrderId: orderId,
      paymentSessionId: `cf_sess_${orderId}`,
      orderStatus: 'ACTIVE',
      cfOrderId: `cf_order_${orderId}`,
      orderAmount,
    })),
    getOrderStatus: jest.fn().mockResolvedValue({
      orderStatus: 'ACTIVE',
    }),
  });

  const capturedFCM = [];
  firebaseProvider.setMockDelegate({
    sendMulticast: jest.fn().mockImplementation(async (payload) => {
      capturedFCM.push(payload);
      return {
        successCount: payload.tokens.length,
        failureCount: 0,
        invalidTokens: [],
      };
    }),
  });

  const partnerUserId = '33333333-3333-4333-8333-333333333333';
  const partnerId = '44444444-4444-4444-8444-444444444444';
  const shopId = '55555555-5555-4555-8555-555555555555';
  const bikeVehicleId = '66666666-6666-4666-8666-666666666666';
  const carVehicleId = '77777777-7777-4777-8777-777777777777';

  // Seed partner, shop, categories
  db.public.none(`
    INSERT INTO users (id, role, name, country_code, phone, email, auth_provider, auth_id, is_active)
    VALUES ('${partnerUserId}', 'partner', 'Fast Wheels Partner', '+91', '9888800001', 'partner@e2e.com', 'firebase', 'auth-partner-e2e', true);

    INSERT INTO partners (id, user_id, business_name, verification_status, is_active)
    VALUES ('${partnerId}', '${partnerUserId}', 'Fast Wheels Rentals', 'approved', true);

    INSERT INTO shops (id, partner_id, shop_name, is_active)
    VALUES ('${shopId}', '${partnerId}', 'Indiranagar Hub', true);
  `);

  const bikeCat = db.public.one("SELECT id FROM vehicle_categories WHERE slug = 'bike'");
  const carCat = db.public.one("SELECT id FROM vehicle_categories WHERE slug = 'car'");

  db.public.none(`
    INSERT INTO vehicles (
      id, shop_id, category_id, brand, model, vehicle_name,
      year, fuel_type, transmission, seats, price_per_hour, price_per_day,
      price_per_week, price_per_month, security_deposit, late_fee_per_hour,
      extra_km_charge, listing_status, pickup_address
    ) VALUES
    (
      '${bikeVehicleId}', '${shopId}', '${bikeCat.id}', 'Honda', 'Activa 6G',
      'Honda Activa 6G', 2024, 'PETROL', 'AUTOMATIC', 2,
      60.00, 500.00, 3000.00, 10000.00, 1000.00, 100.00, 8.00, 'ACTIVE', 'Indiranagar 100ft Road'
    ),
    (
      '${carVehicleId}', '${shopId}', '${carCat.id}', 'Hyundai', 'i20',
      'Hyundai i20', 2024, 'PETROL', 'MANUAL', 5,
      150.00, 1500.00, 9000.00, 32000.00, 3000.00, 250.00, 15.00, 'ACTIVE', 'Indiranagar 100ft Road'
    );

    -- Seed discount coupons
    INSERT INTO coupons (
      id, code, discount_type, discount_value, min_booking_amount,
      max_discount_amount, usage_limit, per_customer_limit,
      valid_from, valid_until, is_active
    ) VALUES
    (
      '10000000-1000-4000-8000-100000000001', 'GONGO100', 'FIXED', 100.00, 300.00,
      100.00, 100, 5,
      NOW() - INTERVAL '1 day', NOW() + INTERVAL '30 days', true
    ),
    (
      '10000000-1000-4000-8000-100000000002', 'GONGO20', 'PERCENTAGE', 20.00, 500.00,
      200.00, 50, 1,
      NOW() - INTERVAL '1 day', NOW() + INTERVAL '30 days', true
    ),
    (
      '10000000-1000-4000-8000-100000000003', 'ONCEONLY', 'FIXED', 50.00, 200.00,
      50.00, 1, 1,
      NOW() - INTERVAL '1 day', NOW() + INTERVAL '30 days', true
    ),
    (
      '10000000-1000-4000-8000-100000000004', 'EXPIRED50', 'FIXED', 50.00, 100.00,
      50.00, 100, 5,
      NOW() - INTERVAL '10 days', NOW() - INTERVAL '1 day', true
    ),
    (
      '10000000-1000-4000-8000-100000000005', 'INACTIVE50', 'FIXED', 50.00, 100.00,
      50.00, 100, 5,
      NOW() - INTERVAL '1 day', NOW() + INTERVAL '30 days', false
    );
  `);

  const adapter = db.adapters.createPg();
  const mockPool = new adapter.Pool();
  const rawQuery = mockPool.query.bind(mockPool);
  pool.query = async (text, params = []) => {
    let q = text;
    let p = params;
    if (typeof q === 'string') {
      if (q.includes('primary_image_url')) {
        q = q.replace(
          /\(\s*SELECT\s+'placeholder:'\s*\|\|\s*vi\.id::text[\s\S]*?LIMIT\s*1\s*\)\s*AS\s*primary_image_url/gi,
          'NULL AS primary_image_url',
        );
      }
      if (q.includes('= ANY($1::text[])')) {
        q = q.replace('= ANY($1::text[])', "IN ('verified', 'approved')");
        p = p.slice(1);
        q = q.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n, 10) - 1}`);
      }
    }
    return rawQuery(q, p);
  };
  pool.connect = mockPool.connect.bind(mockPool);

  const app = createApp();

  const createCustomer = (customProps = {}) => {
    const userId = crypto.randomUUID();
    const phone = customProps.phone || `98${Math.floor(10000000 + Math.random() * 90000000)}`;
    const authId = `auth-${userId}`;
    const name = customProps.name || 'Test Customer';
    const email = customProps.email || `customer-${userId.slice(0, 8)}@test.com`;

    db.public.none(`
      INSERT INTO users (id, role, name, country_code, phone, email, auth_provider, auth_id, is_active)
      VALUES ('${userId}', 'customer', '${name}', '+91', '${phone}', '${email}', 'firebase', '${authId}', true);
    `);

    const token = `mock-token-${userId}`;
    return {
      userId,
      phone,
      email,
      name,
      token: `Bearer ${token}`,
    };
  };

  return {
    db,
    mockPool,
    app,
    partnerUserId,
    partnerId,
    shopId,
    bikeCategoryId: bikeCat.id,
    carCategoryId: carCat.id,
    bikeVehicleId,
    carVehicleId,
    signPayload,
    capturedFCM,
    createCustomer,
  };
}

module.exports = {
  setupE2EEnvironment,
  signPayload,
};
