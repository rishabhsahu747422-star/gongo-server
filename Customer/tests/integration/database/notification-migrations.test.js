'use strict';

const { newDb, DataType } = require('pg-mem');
const crypto = require('crypto');

const usersMigration = require('../../../database/migrations/1726300000000_create-users-table');
const deviceTokensMigration = require('../../../database/migrations/1727500000000_create-customer-device-tokens-table');
const notificationsMigration = require('../../../database/migrations/1727600000000_create-notifications-table');

describe('Notification & Device Database Migrations — Phase 11', () => {
  let db;

  const customerId = '11111111-1111-4111-8111-111111111111';

  beforeEach(async () => {
    db = newDb();

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
    await deviceTokensMigration.up(pgm);
    await notificationsMigration.up(pgm);

    // Seed test user
    db.public.none(`
      INSERT INTO users (id, role, name, country_code, phone, email, auth_provider, auth_id, is_active)
      VALUES ('${customerId}', 'customer', 'Test Customer', '+91', '9876543210', 'test@example.com', 'firebase', 'uid-1', true);
    `);
  });

  describe('customer_device_tokens table', () => {
    it('1. allows inserting valid device token', () => {
      db.public.none(`
        INSERT INTO customer_device_tokens (customer_id, device_token, platform, app_version)
        VALUES ('${customerId}', 'fcm_token_1234567890', 'ANDROID', '1.0.0');
      `);

      const row = db.public.one("SELECT * FROM customer_device_tokens WHERE device_token = 'fcm_token_1234567890'");
      expect(row.customer_id).toBe(customerId);
      expect(row.platform).toBe('ANDROID');
      expect(row.is_active).toBe(true);
    });

    it('2. enforces unique constraint on device_token', () => {
      db.public.none(`
        INSERT INTO customer_device_tokens (customer_id, device_token, platform)
        VALUES ('${customerId}', 'unique_token_999', 'IOS');
      `);

      expect(() => {
        db.public.none(`
          INSERT INTO customer_device_tokens (customer_id, device_token, platform)
          VALUES ('${customerId}', 'unique_token_999', 'IOS');
        `);
      }).toThrow();
    });

    it('3. rejects unsupported platform via check constraint', () => {
      expect(() => {
        db.public.none(`
          INSERT INTO customer_device_tokens (customer_id, device_token, platform)
          VALUES ('${customerId}', 'token_web_123', 'WINDOWS_PHONE');
        `);
      }).toThrow();
    });

    it('4. rejects non-existent customer_id foreign key', () => {
      expect(() => {
        db.public.none(`
          INSERT INTO customer_device_tokens (customer_id, device_token, platform)
          VALUES ('00000000-0000-0000-0000-000000000000', 'token_invalid_user', 'ANDROID');
        `);
      }).toThrow();
    });
  });

  describe('notifications table', () => {
    it('5. allows inserting valid notification', () => {
      db.public.none(`
        INSERT INTO notifications (customer_id, type, title, body, status, data)
        VALUES ('${customerId}', 'BOOKING_CREATED', 'Booking Created', 'Your booking is set', 'PENDING', '{"bookingId":"b1"}');
      `);

      const row = db.public.one(`SELECT * FROM notifications WHERE customer_id = '${customerId}'`);
      expect(row.type).toBe('BOOKING_CREATED');
      expect(row.title).toBe('Booking Created');
      expect(row.status).toBe('PENDING');
      expect(row.read_at).toBeNull();
    });

    it('6. rejects invalid notification status via check constraint', () => {
      expect(() => {
        db.public.none(`
          INSERT INTO notifications (customer_id, type, title, body, status)
          VALUES ('${customerId}', 'BOOKING_CREATED', 'Title', 'Body', 'UNKNOWN_STATUS');
        `);
      }).toThrow();
    });

    it('7. rejects invalid notification type via check constraint', () => {
      expect(() => {
        db.public.none(`
          INSERT INTO notifications (customer_id, type, title, body, status)
          VALUES ('${customerId}', 'FAKE_EVENT_TYPE', 'Title', 'Body', 'PENDING');
        `);
      }).toThrow();
    });

    it('8. enforces uniqueness of event_key when present', () => {
      db.public.none(`
        INSERT INTO notifications (customer_id, type, title, body, event_key)
        VALUES ('${customerId}', 'BOOKING_CREATED', 'Title', 'Body', 'event_unique_001');
      `);

      expect(() => {
        db.public.none(`
          INSERT INTO notifications (customer_id, type, title, body, event_key)
          VALUES ('${customerId}', 'BOOKING_CREATED', 'Title', 'Body', 'event_unique_001');
        `);
      }).toThrow();
    });
  });

  describe('down migrations', () => {
    it('9. runs down migrations cleanly', async () => {
      const pgm = {
        sql: (statement) => {
          if (!statement.includes('TRIGGER')) {
            db.public.none(statement);
          }
        },
      };

      await notificationsMigration.down(pgm);
      await deviceTokensMigration.down(pgm);

      expect(() => db.public.none('SELECT * FROM notifications')).toThrow();
      expect(() => db.public.none('SELECT * FROM customer_device_tokens')).toThrow();
    });
  });
});
