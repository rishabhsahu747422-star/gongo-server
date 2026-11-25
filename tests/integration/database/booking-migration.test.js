'use strict';

const crypto = require('crypto');
const { newDb, DataType } = require('pg-mem');

const usersMigration = require('../../../database/migrations/1726300000000_create-users-table');
const partnersShopsMigration = require('../../../database/migrations/1726600000000_create-partners-shops-table');
const categoriesCitiesMigration = require('../../../database/migrations/1726700000000_create-categories-cities-table');
const vehiclesMigration = require('../../../database/migrations/1726800000000_create-vehicles-table');
const bookingsMigration = require('../../../database/migrations/1727000000000_create-bookings-table');
const idempotencyMigration = require('../../../database/migrations/1727100000000_create-idempotency-keys-table');

describe('Bookings and Idempotency Migrations', () => {
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
  });

  describe('bookings table structure & constraints', () => {
    let customerId;
    let partnerId;
    let shopId;
    let categoryId;
    let vehicleId;

    beforeAll(() => {
      customerId = crypto.randomUUID();
      const partnerUserId = crypto.randomUUID();
      partnerId = crypto.randomUUID();
      shopId = crypto.randomUUID();
      categoryId = crypto.randomUUID();
      vehicleId = crypto.randomUUID();

      // Seed customer & partner user
      db.public.none(`
        INSERT INTO users (id, role, phone, country_code, is_active)
        VALUES ('${customerId}', 'customer', '9870001111', '+91', true),
               ('${partnerUserId}', 'partner', '9870002222', '+91', true)
      `);

      // Seed partner & shop
      db.public.none(`
        INSERT INTO partners (id, user_id, business_name, verification_status, is_active)
        VALUES ('${partnerId}', '${partnerUserId}', 'Test Rentals', 'approved', true)
      `);

      db.public.none(`
        INSERT INTO shops (id, partner_id, shop_name, is_active)
        VALUES ('${shopId}', '${partnerId}', 'Central Shop', true)
      `);

      // Seed category & vehicle
      db.public.none(`
        INSERT INTO vehicle_categories (id, name, slug)
        VALUES ('${categoryId}', 'Bike', 'bike-booking-test')
      `);

      db.public.none(`
        INSERT INTO vehicles (
          id, shop_id, category_id, brand, model, vehicle_name,
          year, fuel_type, transmission, seats, price_per_day,
          security_deposit, listing_status
        ) VALUES (
          '${vehicleId}', '${shopId}', '${categoryId}', 'Honda', 'Activa', 'Activa 6G',
          2023, 'PETROL', 'AUTOMATIC', 2, 500.00, 1000.00, 'ACTIVE'
        )
      `);
    });

    it('1. creates bookings table and allows valid insertion', () => {
      const bookingId = crypto.randomUUID();
      expect(() => {
        db.public.none(`
          INSERT INTO bookings (
            id, customer_id, vehicle_id, status, rental_type,
            start_at, end_at, base_amount, security_deposit, total_amount
          ) VALUES (
            '${bookingId}', '${customerId}', '${vehicleId}', 'PENDING', 'DAILY',
            '2026-10-01T10:00:00Z', '2026-10-02T10:00:00Z', 500.00, 1000.00, 1500.00
          )
        `);
      }).not.toThrow();

      const row = db.public.one(`SELECT * FROM bookings WHERE id = '${bookingId}'`);
      expect(row.status).toBe('PENDING');
      expect(row.rental_type).toBe('DAILY');
      expect(Number(row.base_amount)).toBe(500);
      expect(Number(row.total_amount)).toBe(1500);
    });

    it('2. rejects invalid booking status', () => {
      expect(() => {
        db.public.none(`
          INSERT INTO bookings (
            customer_id, vehicle_id, status, rental_type,
            start_at, end_at, base_amount, total_amount
          ) VALUES (
            '${customerId}', '${vehicleId}', 'INVALID_STATUS', 'DAILY',
            '2026-10-03T10:00:00Z', '2026-10-04T10:00:00Z', 500, 500
          )
        `);
      }).toThrow();
    });

    it('3. rejects invalid rental_type', () => {
      expect(() => {
        db.public.none(`
          INSERT INTO bookings (
            customer_id, vehicle_id, status, rental_type,
            start_at, end_at, base_amount, total_amount
          ) VALUES (
            '${customerId}', '${vehicleId}', 'PENDING', 'YEARLY',
            '2026-10-03T10:00:00Z', '2026-10-04T10:00:00Z', 500, 500
          )
        `);
      }).toThrow();
    });

    it('4. rejects invalid time range where start_at >= end_at', () => {
      expect(() => {
        db.public.none(`
          INSERT INTO bookings (
            customer_id, vehicle_id, status, rental_type,
            start_at, end_at, base_amount, total_amount
          ) VALUES (
            '${customerId}', '${vehicleId}', 'PENDING', 'DAILY',
            '2026-10-05T10:00:00Z', '2026-10-05T10:00:00Z', 500, 500
          )
        `);
      }).toThrow();

      expect(() => {
        db.public.none(`
          INSERT INTO bookings (
            customer_id, vehicle_id, status, rental_type,
            start_at, end_at, base_amount, total_amount
          ) VALUES (
            '${customerId}', '${vehicleId}', 'PENDING', 'DAILY',
            '2026-10-06T10:00:00Z', '2026-10-05T10:00:00Z', 500, 500
          )
        `);
      }).toThrow();
    });

    it('5. rejects negative monetary amounts', () => {
      expect(() => {
        db.public.none(`
          INSERT INTO bookings (
            customer_id, vehicle_id, status, rental_type,
            start_at, end_at, base_amount, total_amount
          ) VALUES (
            '${customerId}', '${vehicleId}', 'PENDING', 'DAILY',
            '2026-10-07T10:00:00Z', '2026-10-08T10:00:00Z', -100, 500
          )
        `);
      }).toThrow();

      expect(() => {
        db.public.none(`
          INSERT INTO bookings (
            customer_id, vehicle_id, status, rental_type,
            start_at, end_at, base_amount, security_deposit, total_amount
          ) VALUES (
            '${customerId}', '${vehicleId}', 'PENDING', 'DAILY',
            '2026-10-07T10:00:00Z', '2026-10-08T10:00:00Z', 500, -50, 500
          )
        `);
      }).toThrow();
    });

    it('6. rejects non-existent customer_id foreign key', () => {
      const nonExistentCustomerId = crypto.randomUUID();
      expect(() => {
        db.public.none(`
          INSERT INTO bookings (
            customer_id, vehicle_id, status, rental_type,
            start_at, end_at, base_amount, total_amount
          ) VALUES (
            '${nonExistentCustomerId}', '${vehicleId}', 'PENDING', 'DAILY',
            '2026-10-09T10:00:00Z', '2026-10-10T10:00:00Z', 500, 500
          )
        `);
      }).toThrow();
    });
  });

  describe('idempotency_keys table structure & constraints', () => {
    it('7. creates idempotency_keys table and enforces unique (user_id, key)', () => {
      const testUserId = crypto.randomUUID();
      db.public.none(`
        INSERT INTO users (id, role, phone, country_code, is_active)
        VALUES ('${testUserId}', 'customer', '9870003333', '+91', true)
      `);

      const key = 'idem-key-1';
      expect(() => {
        db.public.none(`
          INSERT INTO idempotency_keys (
            key, user_id, request_path, request_hash,
            response_status, response_body, expires_at
          ) VALUES (
            '${key}', '${testUserId}', '/api/v1/bookings', 'hash123',
            201, '{"success": true}', CURRENT_TIMESTAMP + INTERVAL '24 hours'
          )
        `);
      }).not.toThrow();

      // Duplicate key for same user must throw unique constraint violation
      expect(() => {
        db.public.none(`
          INSERT INTO idempotency_keys (
            key, user_id, request_path, request_hash,
            response_status, response_body, expires_at
          ) VALUES (
            '${key}', '${testUserId}', '/api/v1/bookings', 'hash456',
            201, '{"success": true}', CURRENT_TIMESTAMP + INTERVAL '24 hours'
          )
        `);
      }).toThrow();
    });
  });

  describe('down migration', () => {
    it('8. executes down migration cleanly', async () => {
      const freshDb = newDb();
      freshDb.registerExtension('pgcrypto', (schema) => {
        schema.registerFunction({
          name: 'gen_random_uuid',
          returns: DataType.uuid,
          impure: true,
          implementation: () => crypto.randomUUID(),
        });
      });
      const freshPgm = {
        sql: (statement) => {
          if (
            !statement.includes('LANGUAGE plpgsql')
            && !statement.includes('TRIGGER')
            && !statement.includes('btree_gist')
            && !statement.includes('EXCLUDE')
          ) {
            freshDb.public.none(statement);
          }
        },
      };

      await usersMigration.up(freshPgm);
      await partnersShopsMigration.up(freshPgm);
      await categoriesCitiesMigration.up(freshPgm);
      await vehiclesMigration.up(freshPgm);
      await bookingsMigration.up(freshPgm);
      await idempotencyMigration.up(freshPgm);

      await idempotencyMigration.down(freshPgm);
      await bookingsMigration.down(freshPgm);

      expect(() => {
        freshDb.public.none('SELECT id FROM bookings LIMIT 1');
      }).toThrow();
      expect(() => {
        freshDb.public.none('SELECT id FROM idempotency_keys LIMIT 1');
      }).toThrow();
    });
  });
});
