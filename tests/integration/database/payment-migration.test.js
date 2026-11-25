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

describe('Payments Database Migration — Phase 10', () => {
  let db;
  let pgm;

  const customerId = crypto.randomUUID();
  const partnerUserId = crypto.randomUUID();
  const partnerId = crypto.randomUUID();
  const shopId = crypto.randomUUID();
  let categoryId;
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
    categoryId = cat.id;

    db.public.none(`
      INSERT INTO vehicles (
        id, shop_id, category_id,
        vehicle_name, brand, model, year, registration_number,
        fuel_type, transmission, seats,
        price_per_hour, price_per_day, price_per_week, price_per_month,
        security_deposit, late_fee_per_hour, extra_km_charge,
        listing_status, pickup_address
      ) VALUES (
        '${vehicleId}', '${shopId}', '${categoryId}',
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
        '${bookingId}', '${customerId}', '${vehicleId}', 'PENDING', 'DAILY',
        '2026-11-01T10:00:00Z', '2026-11-02T10:00:00Z', 600.00, 2000.00, 2600.00
      );
    `);
  });

  describe('payments table structure & constraints', () => {
    it('1. creates payments table and allows valid insertion', () => {
      const paymentId = crypto.randomUUID();
      const providerOrderId = 'cf_order_001';

      expect(() => {
        db.public.none(`
          INSERT INTO payments (
            id, booking_id, customer_id, provider, provider_order_id,
            amount, currency, status
          ) VALUES (
            '${paymentId}', '${bookingId}', '${customerId}', 'CASHFREE', '${providerOrderId}',
            2600.00, 'INR', 'PENDING'
          )
        `);
      }).not.toThrow();

      const row = db.public.one(`SELECT * FROM payments WHERE id = '${paymentId}'`);
      expect(row.provider_order_id).toBe('cf_order_001');
      expect(row.provider).toBe('CASHFREE');
      expect(Number(row.amount)).toBe(2600.00);
      expect(row.currency).toBe('INR');
      expect(row.status).toBe('PENDING');
    });

    it('2. enforces unique constraint on provider_order_id', () => {
      expect(() => {
        db.public.none(`
          INSERT INTO payments (
            booking_id, customer_id, provider, provider_order_id,
            amount, currency, status
          ) VALUES (
            '${bookingId}', '${customerId}', 'CASHFREE', 'cf_order_001',
            2600.00, 'INR', 'PENDING'
          )
        `);
      }).toThrow();
    });

    it('3. rejects invalid payment status', () => {
      expect(() => {
        db.public.none(`
          INSERT INTO payments (
            booking_id, customer_id, provider, provider_order_id,
            amount, currency, status
          ) VALUES (
            '${bookingId}', '${customerId}', 'CASHFREE', 'cf_order_002',
            2600.00, 'INR', 'INVALID_STATUS'
          )
        `);
      }).toThrow();
    });

    it('4. rejects negative payment amount', () => {
      expect(() => {
        db.public.none(`
          INSERT INTO payments (
            booking_id, customer_id, provider, provider_order_id,
            amount, currency, status
          ) VALUES (
            '${bookingId}', '${customerId}', 'CASHFREE', 'cf_order_003',
            -50.00, 'INR', 'PENDING'
          )
        `);
      }).toThrow();
    });

    it('5. rejects non-existent booking_id foreign key', () => {
      const nonExistentBookingId = crypto.randomUUID();
      expect(() => {
        db.public.none(`
          INSERT INTO payments (
            booking_id, customer_id, provider, provider_order_id,
            amount, currency, status
          ) VALUES (
            '${nonExistentBookingId}', '${customerId}', 'CASHFREE', 'cf_order_004',
            100.00, 'INR', 'PENDING'
          )
        `);
      }).toThrow();
    });

    it('6. rejects non-existent customer_id foreign key', () => {
      const nonExistentCustomerId = crypto.randomUUID();
      expect(() => {
        db.public.none(`
          INSERT INTO payments (
            booking_id, customer_id, provider, provider_order_id,
            amount, currency, status
          ) VALUES (
            '${bookingId}', '${nonExistentCustomerId}', 'CASHFREE', 'cf_order_005',
            100.00, 'INR', 'PENDING'
          )
        `);
      }).toThrow();
    });
  });

  describe('down migration', () => {
    it('7. executes down migration cleanly', async () => {
      await expect(paymentsMigration.down(pgm)).resolves.not.toThrow();
    });
  });
});
