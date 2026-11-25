'use strict';

const crypto = require('crypto');
const { newDb, DataType } = require('pg-mem');

const usersMigration = require('../../../database/migrations/1726300000000_create-users-table');
const partnersShopsMigration = require('../../../database/migrations/1726600000000_create-partners-shops-table');
const categoriesCitiesMigration = require('../../../database/migrations/1726700000000_create-categories-cities-table');
const vehiclesMigration = require('../../../database/migrations/1726800000000_create-vehicles-table');
const bookingsMigration = require('../../../database/migrations/1727000000000_create-bookings-table');
const idempotencyMigration = require('../../../database/migrations/1727100000000_create-idempotency-keys-table');
const couponsMigration = require('../../../database/migrations/1727200000000_create-coupons-table');
const addCouponColumnsMigration = require('../../../database/migrations/1727300000000_add-coupon-columns-to-bookings');
const paymentsMigration = require('../../../database/migrations/1727400000000_create-payments-table');
const returnVerificationsMigration = require('../../../database/migrations/1728000000000_create-booking-return-verifications-table');
const addPaymentTypeMigration = require('../../../database/migrations/1728100000000_add-payment-type-to-payments');

describe('Post-Rental Settlement Database Migrations', () => {
  let db;
  let pgm;

  const customerId = crypto.randomUUID();
  const partnerUserId = crypto.randomUUID();
  const partnerId = crypto.randomUUID();
  const shopId = crypto.randomUUID();
  const vehicleId = crypto.randomUUID();
  const bookingId = crypto.randomUUID();

  beforeAll(async () => {
    db = newDb();

    db.registerExtension('pgcrypto', (schema) => {
      schema.registerFunction({
        name: 'gen_random_uuid',
        returns: DataType.uuid,
        impure: true,
        implementation: () => crypto.randomUUID(),
      });
    });

    pgm = {
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
    await partnersShopsMigration.up(pgm);
    await categoriesCitiesMigration.up(pgm);
    await vehiclesMigration.up(pgm);
    await bookingsMigration.up(pgm);
    await idempotencyMigration.up(pgm);
    await couponsMigration.up(pgm);
    await addCouponColumnsMigration.up(pgm);
    await paymentsMigration.up(pgm);

    // Seed test user, partner, vehicle, booking
    db.public.none(`
      INSERT INTO users (id, role, name, country_code, phone, email, auth_provider, auth_id, is_active)
      VALUES
        ('${customerId}', 'customer', 'Cust Alice', '+91', '9870000010', 'alice.pay@example.com', 'firebase', 'uid-pay-alice', true),
        ('${partnerUserId}', 'partner', 'Part Bob', '+91', '9870000011', 'bob.pay@example.com', 'firebase', 'uid-pay-bob', true);

      INSERT INTO partners (id, user_id, business_name, verification_status, is_active)
      VALUES ('${partnerId}', '${partnerUserId}', 'Pay Rentals', 'approved', true);

      INSERT INTO shops (id, partner_id, shop_name, is_active)
      VALUES ('${shopId}', '${partnerId}', 'Pay Branch', true);
    `);

    const cat = db.public.one("SELECT id FROM vehicle_categories WHERE slug = 'bike'");

    db.public.none(`
      INSERT INTO vehicles (
        id, shop_id, category_id,
        vehicle_name, brand, model, year, registration_number,
        fuel_type, transmission, seats,
        price_per_hour, price_per_day, price_per_week, price_per_month,
        security_deposit, late_fee_per_hour, extra_km_charge,
        listing_status, pickup_address
      ) VALUES (
        '${vehicleId}', '${shopId}', '${cat.id}',
        'TVS Apache', 'TVS', 'Apache RTR', 2023, 'KA01AP1234',
        'PETROL', 'MANUAL', 2,
        80.00, 600.00, 3600.00, 12000.00,
        2000.00, 100.00, 8.00,
        'ACTIVE', 'Koramangala Hub'
      );

      INSERT INTO bookings (
        id, customer_id, vehicle_id, status, rental_type,
        start_at, end_at, base_amount, security_deposit, total_amount
      ) VALUES (
        '${bookingId}', '${customerId}', '${vehicleId}', 'COMPLETED', 'DAILY',
        '2026-11-01T10:00:00Z', '2026-11-02T10:00:00Z', 600.00, 2000.00, 2600.00
      );
    `);
  });

  describe('Migration: 1728000000000_create-booking-return-verifications-table', () => {
    it('1. successfully applies up migration and creates return verifications table', async () => {
      await returnVerificationsMigration.up(pgm);

      const res = db.public.none(`
        INSERT INTO booking_return_verifications (
          booking_id, late_minutes, late_fee, extra_km, extra_km_fee, notes
        ) VALUES (
          '${bookingId}', 30, 100.00, 15.00, 75.00, 'Test return verification'
        );
      `);
      expect(res).toBeUndefined();

      const row = db.public.one(`
        SELECT * FROM booking_return_verifications WHERE booking_id = '${bookingId}'
      `);
      expect(row).toBeDefined();
      expect(Number(row.late_fee)).toBe(100.00);
      expect(Number(row.extra_km_fee)).toBe(75.00);
    });

    it('2. enforces unique booking_id constraint', () => {
      expect(() => {
        db.public.none(`
          INSERT INTO booking_return_verifications (
            booking_id, late_fee, extra_km_fee
          ) VALUES (
            '${bookingId}', 50.00, 20.00
          );
        `);
      }).toThrow();
    });

    it('3. rejects negative monetary amounts via check constraints', () => {
      const anotherBookingId = crypto.randomUUID();
      db.public.none(`
        INSERT INTO bookings (
          id, customer_id, vehicle_id, status, rental_type,
          start_at, end_at, base_amount, security_deposit, total_amount
        ) VALUES (
          '${anotherBookingId}', '${customerId}', '${vehicleId}', 'COMPLETED', 'DAILY',
          '2026-11-03T10:00:00Z', '2026-11-04T10:00:00Z', 600.00, 2000.00, 2600.00
        );
      `);

      expect(() => {
        db.public.none(`
          INSERT INTO booking_return_verifications (
            booking_id, late_fee, extra_km_fee
          ) VALUES (
            '${anotherBookingId}', -50.00, 20.00
          );
        `);
      }).toThrow();
    });
  });

  describe('Migration: 1728100000000_add-payment-type-to-payments', () => {
    it('4. successfully applies up migration and enforces payment_type check constraint', async () => {
      await addPaymentTypeMigration.up(pgm);

      const advPaymentId = crypto.randomUUID();
      const settlePaymentId = crypto.randomUUID();

      // Valid BOOKING_ADVANCE
      db.public.none(`
        INSERT INTO payments (
          id, booking_id, customer_id, provider_order_id, amount, payment_type
        ) VALUES (
          '${advPaymentId}', '${bookingId}', '${customerId}', 'cf_order_m1', 2600.00, 'BOOKING_ADVANCE'
        );
      `);

      // Valid POST_RENTAL_SETTLEMENT
      db.public.none(`
        INSERT INTO payments (
          id, booking_id, customer_id, provider_order_id, amount, payment_type
        ) VALUES (
          '${settlePaymentId}', '${bookingId}', '${customerId}', 'cf_order_m2', 175.00, 'POST_RENTAL_SETTLEMENT'
        );
      `);

      const p1 = db.public.one(`SELECT payment_type FROM payments WHERE id = '${advPaymentId}'`);
      expect(p1.payment_type).toBe('BOOKING_ADVANCE');

      const p2 = db.public.one(`SELECT payment_type FROM payments WHERE id = '${settlePaymentId}'`);
      expect(p2.payment_type).toBe('POST_RENTAL_SETTLEMENT');

      // Invalid payment_type should fail check constraint
      expect(() => {
        db.public.none(`
          INSERT INTO payments (
            id, booking_id, customer_id, provider_order_id, amount, payment_type
          ) VALUES (
            gen_random_uuid(), '${bookingId}', '${customerId}', 'cf_order_inv', 100.00, 'INVALID_TYPE'
          );
        `);
      }).toThrow();
    });
  });
});
