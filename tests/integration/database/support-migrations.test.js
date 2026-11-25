'use strict';

const { newDb, DataType } = require('pg-mem');
const crypto = require('crypto');

const usersMigration = require('../../../database/migrations/1726300000000_create-users-table');
const partnersShopsMigration = require('../../../database/migrations/1726600000000_create-partners-shops-table');
const categoriesCitiesMigration = require('../../../database/migrations/1726700000000_create-categories-cities-table');
const vehiclesMigration = require('../../../database/migrations/1726800000000_create-vehicles-table');
const bookingsMigration = require('../../../database/migrations/1727000000000_create-bookings-table');
const notificationsMigration = require('../../../database/migrations/1727600000000_create-notifications-table');
const supportTicketsMigration = require('../../../database/migrations/1727700000000_create-support-tickets-table');
const supportMessagesMigration = require('../../../database/migrations/1727800000000_create-support-ticket-messages-table');
const addSupportReplyTypeMigration = require('../../../database/migrations/1727900000000_add-support-reply-notification-type');

describe('Support Database Migrations — Phase 12', () => {
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
    await partnersShopsMigration.up(pgm);
    await categoriesCitiesMigration.up(pgm);
    await vehiclesMigration.up(pgm);
    await bookingsMigration.up(pgm);
    await notificationsMigration.up(pgm);
    await supportTicketsMigration.up(pgm);
    await supportMessagesMigration.up(pgm);
    await addSupportReplyTypeMigration.up(pgm);

    // Seed test customer
    db.public.none(`
      INSERT INTO users (id, role, name, country_code, phone, email, auth_provider, auth_id, is_active)
      VALUES ('${customerId}', 'customer', 'Test Customer', '+91', '9876543210', 'test@example.com', 'firebase', 'uid-1', true);
    `);
  });

  describe('support_tickets table', () => {
    it('1. allows inserting a valid support ticket', () => {
      db.public.none(`
        INSERT INTO support_tickets (customer_id, ticket_number, category, subject, priority, status)
        VALUES ('${customerId}', 'TKT-20260919-001', 'BOOKING', 'Need help with booking', 'HIGH', 'OPEN');
      `);

      const row = db.public.one("SELECT * FROM support_tickets WHERE ticket_number = 'TKT-20260919-001'");
      expect(row.customer_id).toBe(customerId);
      expect(row.category).toBe('BOOKING');
      expect(row.priority).toBe('HIGH');
      expect(row.status).toBe('OPEN');
    });

    it('2. enforces category check constraint', () => {
      expect(() => {
        db.public.none(`
          INSERT INTO support_tickets (customer_id, ticket_number, category, subject, priority)
          VALUES ('${customerId}', 'TKT-INV-CAT', 'INVALID_CAT', 'Test subject', 'MEDIUM');
        `);
      }).toThrow();
    });

    it('3. enforces priority check constraint', () => {
      expect(() => {
        db.public.none(`
          INSERT INTO support_tickets (customer_id, ticket_number, category, subject, priority)
          VALUES ('${customerId}', 'TKT-INV-PRI', 'PAYMENT', 'Test subject', 'SUPER_HIGH');
        `);
      }).toThrow();
    });

    it('4. enforces status check constraint', () => {
      expect(() => {
        db.public.none(`
          INSERT INTO support_tickets (customer_id, ticket_number, category, subject, status)
          VALUES ('${customerId}', 'TKT-INV-STA', 'PAYMENT', 'Test subject', 'UNKNOWN_STATUS');
        `);
      }).toThrow();
    });

    it('5. enforces ticket_number uniqueness', () => {
      db.public.none(`
        INSERT INTO support_tickets (customer_id, ticket_number, category, subject)
        VALUES ('${customerId}', 'TKT-DUP-01', 'OTHER', 'First ticket');
      `);

      expect(() => {
        db.public.none(`
          INSERT INTO support_tickets (customer_id, ticket_number, category, subject)
          VALUES ('${customerId}', 'TKT-DUP-01', 'OTHER', 'Second ticket');
        `);
      }).toThrow();
    });
  });

  describe('support_ticket_messages table', () => {
    let ticketId;

    beforeEach(() => {
      db.public.none(`
        INSERT INTO support_tickets (id, customer_id, ticket_number, category, subject)
        VALUES ('88888888-8888-4888-8888-888888888888', '${customerId}', 'TKT-MSG-001', 'TECHNICAL', 'App crashes');
      `);
      ticketId = '88888888-8888-4888-8888-888888888888';
    });

    it('6. allows inserting messages with customer and support sender types', () => {
      db.public.none(`
        INSERT INTO support_ticket_messages (ticket_id, sender_type, sender_id, message)
        VALUES ('${ticketId}', 'CUSTOMER', '${customerId}', 'Hello, app is crashing on startup.');
      `);

      const supportAgentId = '99999999-9999-4999-8999-999999999999';
      db.public.none(`
        INSERT INTO support_ticket_messages (ticket_id, sender_type, sender_id, message)
        VALUES ('${ticketId}', 'SUPPORT', '${supportAgentId}', 'We are looking into this for you.');
      `);

      const messages = db.public.many(`SELECT * FROM support_ticket_messages WHERE ticket_id = '${ticketId}' ORDER BY created_at ASC`);
      expect(messages).toHaveLength(2);
      expect(messages[0].sender_type).toBe('CUSTOMER');
      expect(messages[1].sender_type).toBe('SUPPORT');
    });

    it('7. enforces sender_type check constraint', () => {
      expect(() => {
        db.public.none(`
          INSERT INTO support_ticket_messages (ticket_id, sender_type, sender_id, message)
          VALUES ('${ticketId}', 'BOT', '${customerId}', 'Automated msg');
        `);
      }).toThrow();
    });

    it('8. cascades delete when ticket is deleted', () => {
      db.public.none(`
        INSERT INTO support_ticket_messages (ticket_id, sender_type, sender_id, message)
        VALUES ('${ticketId}', 'CUSTOMER', '${customerId}', 'Will be deleted');
      `);

      db.public.none(`DELETE FROM support_tickets WHERE id = '${ticketId}'`);
      const remaining = db.public.many(`SELECT * FROM support_ticket_messages WHERE ticket_id = '${ticketId}'`);
      expect(remaining).toHaveLength(0);
    });
  });

  describe('notifications table check constraint extension', () => {
    it('9. allows inserting SUPPORT_REPLY notification type', () => {
      db.public.none(`
        INSERT INTO notifications (customer_id, type, title, body)
        VALUES ('${customerId}', 'SUPPORT_REPLY', 'Support Update', 'Your ticket has a new reply.');
      `);

      const row = db.public.one("SELECT * FROM notifications WHERE type = 'SUPPORT_REPLY'");
      expect(row.type).toBe('SUPPORT_REPLY');
      expect(row.title).toBe('Support Update');
    });
  });

  describe('down migrations', () => {
    it('10. safely executes down migrations', async () => {
      const pgm = {
        sql: (statement) => {
          if (!statement.includes('TRIGGER')) {
            db.public.none(statement);
          }
        },
      };

      await addSupportReplyTypeMigration.down(pgm);
      await supportMessagesMigration.down(pgm);
      await supportTicketsMigration.down(pgm);

      const tables = db.public.many(`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
      `).map((t) => t.table_name);

      expect(tables).not.toContain('support_ticket_messages');
      expect(tables).not.toContain('support_tickets');
    });
  });
});
