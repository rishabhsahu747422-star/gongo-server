'use strict';

const { newDb, DataType } = require('pg-mem');
const crypto = require('crypto');
const usersMigration = require('../../../database/migrations/1726300000000_create-users-table');
const addressesMigration = require('../../../database/migrations/1726500000000_create-customer-addresses-table');

describe('customer_addresses migration', () => {
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

    // pg-mem does not support LANGUAGE plpgsql or TRIGGER statements
    pgm = {
      sql: (statement) => {
        if (!statement.includes('LANGUAGE plpgsql') && !statement.includes('TRIGGER')) {
          db.public.none(statement);
        }
      },
    };

    await usersMigration.up(pgm);
    await addressesMigration.up(pgm);
  });

  describe('table structure', () => {
    it('creates customer_addresses table', () => {
      expect(() => {
        db.public.none('SELECT id FROM customer_addresses LIMIT 1');
      }).not.toThrow();
    });

    it('has all required columns', () => {
      const userId = crypto.randomUUID();

      // Insert a user first (FK requirement)
      db.public.none(`
        INSERT INTO users (id, role, phone, country_code, auth_provider, auth_id, is_active)
        VALUES ('${userId}', 'customer', '9876540001', '+91', 'firebase', 'uid-mig-1', true)
      `);

      expect(() => {
        db.public.none(`
          INSERT INTO customer_addresses (
            id, user_id, label, full_address, address_line1, address_line2,
            landmark, city, state, postal_code, country_code,
            latitude, longitude, is_default
          ) VALUES (
            gen_random_uuid(), '${userId}', 'HOME', '123 Test Street, Mumbai',
            'Line 1', 'Line 2', 'Near Station', 'Mumbai', 'Maharashtra',
            '400001', 'IN', 19.0760, 72.8777, false
          )
        `);
      }).not.toThrow();
    });

    it('sets correct column defaults', () => {
      const userId = crypto.randomUUID();
      db.public.none(`
        INSERT INTO users (id, role, phone, country_code, auth_provider, auth_id, is_active)
        VALUES ('${userId}', 'customer', '9876540002', '+91', 'firebase', 'uid-mig-2', true)
      `);

      db.public.none(`
        INSERT INTO customer_addresses (user_id, full_address)
        VALUES ('${userId}', 'Default test address, City')
      `);

      const rows = db.public.many(
        `SELECT label, country_code, is_default FROM customer_addresses WHERE user_id = '${userId}'`,
      );
      expect(rows[0].label).toBe('OTHER');
      expect(rows[0].country_code).toBe('IN');
      expect(rows[0].is_default).toBe(false);
    });
  });

  describe('CHECK constraints', () => {
    let constraintUserId;

    beforeAll(() => {
      constraintUserId = crypto.randomUUID();
      db.public.none(`
        INSERT INTO users (id, role, phone, country_code, auth_provider, auth_id, is_active)
        VALUES ('${constraintUserId}', 'customer', '9876540003', '+91', 'firebase', 'uid-mig-3', true)
      `);
    });

    it('rejects invalid label', () => {
      expect(() => {
        db.public.none(`
          INSERT INTO customer_addresses (user_id, label, full_address)
          VALUES ('${constraintUserId}', 'INVALID', 'Some address here')
        `);
      }).toThrow();
    });

    it('accepts valid labels: HOME, WORK, OTHER', () => {
      ['HOME', 'WORK', 'OTHER'].forEach((label) => {
        expect(() => {
          db.public.none(`
            INSERT INTO customer_addresses (user_id, label, full_address)
            VALUES ('${constraintUserId}', '${label}', 'Valid address ${label}')
          `);
        }).not.toThrow();
      });
    });

    it('rejects latitude out of range', () => {
      expect(() => {
        db.public.none(`
          INSERT INTO customer_addresses (user_id, full_address, latitude, longitude)
          VALUES ('${constraintUserId}', 'Out of range lat', 91.0, 72.0)
        `);
      }).toThrow();
    });

    it('rejects longitude out of range', () => {
      expect(() => {
        db.public.none(`
          INSERT INTO customer_addresses (user_id, full_address, latitude, longitude)
          VALUES ('${constraintUserId}', 'Out of range lon', 19.0, 181.0)
        `);
      }).toThrow();
    });

    it('accepts null coordinates', () => {
      expect(() => {
        db.public.none(`
          INSERT INTO customer_addresses (user_id, full_address, latitude, longitude)
          VALUES ('${constraintUserId}', 'No coords address', NULL, NULL)
        `);
      }).not.toThrow();
    });
  });

  describe('partial unique index for is_default', () => {
    it('allows multiple non-default addresses for the same user', () => {
      const userId = crypto.randomUUID();
      db.public.none(`
        INSERT INTO users (id, role, phone, country_code, auth_provider, auth_id, is_active)
        VALUES ('${userId}', 'customer', '9876540004', '+91', 'firebase', 'uid-mig-4', true)
      `);

      expect(() => {
        db.public.none(`
          INSERT INTO customer_addresses (user_id, full_address, is_default)
          VALUES ('${userId}', 'Address A', false)
        `);
        db.public.none(`
          INSERT INTO customer_addresses (user_id, full_address, is_default)
          VALUES ('${userId}', 'Address B', false)
        `);
      }).not.toThrow();
    });

    it('prevents two default addresses for the same user', () => {
      const userId = crypto.randomUUID();
      db.public.none(`
        INSERT INTO users (id, role, phone, country_code, auth_provider, auth_id, is_active)
        VALUES ('${userId}', 'customer', '9876540005', '+91', 'firebase', 'uid-mig-5', true)
      `);

      db.public.none(`
        INSERT INTO customer_addresses (user_id, full_address, is_default)
        VALUES ('${userId}', 'First default', true)
      `);

      expect(() => {
        db.public.none(`
          INSERT INTO customer_addresses (user_id, full_address, is_default)
          VALUES ('${userId}', 'Second default', true)
        `);
      }).toThrow();
    });

    it('allows different users each to have one default', () => {
      const userIdA = crypto.randomUUID();
      const userIdB = crypto.randomUUID();

      db.public.none(`
        INSERT INTO users (id, role, phone, country_code, auth_provider, auth_id, is_active)
        VALUES
          ('${userIdA}', 'customer', '9876540006', '+91', 'firebase', 'uid-mig-6', true),
          ('${userIdB}', 'customer', '9876540007', '+91', 'firebase', 'uid-mig-7', true)
      `);

      expect(() => {
        db.public.none(`
          INSERT INTO customer_addresses (user_id, full_address, is_default)
          VALUES ('${userIdA}', 'User A default', true)
        `);
        db.public.none(`
          INSERT INTO customer_addresses (user_id, full_address, is_default)
          VALUES ('${userIdB}', 'User B default', true)
        `);
      }).not.toThrow();
    });
  });

  describe('down migration', () => {
    it('drops the customer_addresses table', async () => {
      // Create a fresh db for down migration test
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
          if (!statement.includes('LANGUAGE plpgsql') && !statement.includes('TRIGGER')) {
            freshDb.public.none(statement);
          }
        },
      };

      await usersMigration.up(freshPgm);
      await addressesMigration.up(freshPgm);
      await addressesMigration.down(freshPgm);

      expect(() => {
        freshDb.public.none('SELECT id FROM customer_addresses LIMIT 1');
      }).toThrow();
    });
  });
});
