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

describe('Coupons and Coupon Redemptions Database Migrations', () => {
  let db;
  let pgm;

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
  });

  describe('coupons table constraints', () => {
    it('allows valid coupon creation', () => {
      const id = crypto.randomUUID();
      expect(() => {
        db.public.none(`
          INSERT INTO coupons (
            id, code, description, discount_type, discount_value,
            min_booking_amount, max_discount_amount, usage_limit,
            per_customer_limit, valid_from, valid_until, is_active
          ) VALUES (
            '${id}', 'WELCOME50', '50% off first booking', 'PERCENTAGE', 50.00,
            500.00, 200.00, 100,
            1, '2026-01-01T00:00:00Z', '2026-12-31T23:59:59Z', true
          )
        `);
      }).not.toThrow();

      const row = db.public.one(`SELECT * FROM coupons WHERE id = '${id}'`);
      expect(row.code).toBe('WELCOME50');
      expect(Number(row.discount_value)).toBe(50);
      expect(Number(row.max_discount_amount)).toBe(200);
    });

    it('enforces case-insensitive uniqueness on coupon code', () => {
      expect(() => {
        db.public.none(`
          INSERT INTO coupons (
            code, discount_type, discount_value,
            valid_from, valid_until
          ) VALUES (
            'welcome50', 'FIXED', 100.00,
            '2026-01-01T00:00:00Z', '2026-12-31T23:59:59Z'
          )
        `);
      }).toThrow();
    });

    it('rejects invalid discount_type', () => {
      expect(() => {
        db.public.none(`
          INSERT INTO coupons (
            code, discount_type, discount_value,
            valid_from, valid_until
          ) VALUES (
            'INVALIDTYPE', 'CASHBACK', 50.00,
            '2026-01-01T00:00:00Z', '2026-12-31T23:59:59Z'
          )
        `);
      }).toThrow();
    });

    it('rejects percentage discount greater than 100', () => {
      expect(() => {
        db.public.none(`
          INSERT INTO coupons (
            code, discount_type, discount_value,
            valid_from, valid_until
          ) VALUES (
            'TOOHIGH', 'PERCENTAGE', 105.00,
            '2026-01-01T00:00:00Z', '2026-12-31T23:59:59Z'
          )
        `);
      }).toThrow();
    });

    it('rejects negative discount_value', () => {
      expect(() => {
        db.public.none(`
          INSERT INTO coupons (
            code, discount_type, discount_value,
            valid_from, valid_until
          ) VALUES (
            'NEGATIVE', 'FIXED', -50.00,
            '2026-01-01T00:00:00Z', '2026-12-31T23:59:59Z'
          )
        `);
      }).toThrow();
    });

    it('rejects invalid validity period where valid_from > valid_until', () => {
      expect(() => {
        db.public.none(`
          INSERT INTO coupons (
            code, discount_type, discount_value,
            valid_from, valid_until
          ) VALUES (
            'TIMEWARP', 'FIXED', 50.00,
            '2026-12-31T23:59:59Z', '2026-01-01T00:00:00Z'
          )
        `);
      }).toThrow();
    });
  });

  describe('coupon_redemptions table constraints', () => {
    let customerId;
    let couponId;

    beforeAll(() => {
      customerId = crypto.randomUUID();
      db.public.none(`
        INSERT INTO users (id, role, name, country_code, phone, email, auth_provider, auth_id, is_active)
        VALUES ('${customerId}', 'customer', 'Test Customer', '+91', '9870000000', 'redemp@example.com', 'firebase', 'auth-redemp', true)
      `);

      couponId = crypto.randomUUID();
      db.public.none(`
        INSERT INTO coupons (
          id, code, discount_type, discount_value,
          valid_from, valid_until
        ) VALUES (
          '${couponId}', 'FLAT100', 'FIXED', 100.00,
          '2026-01-01T00:00:00Z', '2026-12-31T23:59:59Z'
        )
      `);
    });

    it('allows valid redemption record creation', () => {
      const redempId = crypto.randomUUID();
      expect(() => {
        db.public.none(`
          INSERT INTO coupon_redemptions (
            id, coupon_id, customer_id, discount_amount
          ) VALUES (
            '${redempId}', '${couponId}', '${customerId}', 100.00
          )
        `);
      }).not.toThrow();

      const row = db.public.one(`SELECT * FROM coupon_redemptions WHERE id = '${redempId}'`);
      expect(row.coupon_id).toBe(couponId);
      expect(row.customer_id).toBe(customerId);
      expect(Number(row.discount_amount)).toBe(100);
    });

    it('rejects negative discount_amount in coupon_redemptions', () => {
      expect(() => {
        db.public.none(`
          INSERT INTO coupon_redemptions (
            coupon_id, customer_id, discount_amount
          ) VALUES (
            '${couponId}', '${customerId}', -10.00
          )
        `);
      }).toThrow();
    });
  });

  describe('down migrations', () => {
    it('executes down migration cleanly', async () => {
      await expect(addCouponColumnsMigration.down(pgm)).resolves.not.toThrow();
      await expect(couponsMigration.down(pgm)).resolves.not.toThrow();
    });
  });
});
