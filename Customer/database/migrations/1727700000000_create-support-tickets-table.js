'use strict';

/**
 * Migration: Create support_tickets table.
 *
 * DESIGN DECISIONS:
 *   - customer_id references users(id) ON DELETE CASCADE.
 *   - booking_id references bookings(id) ON DELETE SET NULL (optional ticket context).
 *   - ticket_number is a unique alphanumeric identifier (e.g. TKT-YYYYMMDD-XXXX).
 *   - category restricted to defined enum categories.
 *   - status lifecycle: OPEN -> IN_PROGRESS -> WAITING_FOR_CUSTOMER -> RESOLVED -> CLOSED.
 *   - priority: LOW, MEDIUM, HIGH.
 *   - Indexes on (customer_id, created_at DESC), (customer_id, status), booking_id, ticket_number.
 */

exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id             UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id        UUID           REFERENCES users(id) ON DELETE CASCADE,
      customer_id    UUID           REFERENCES users(id) ON DELETE CASCADE,
      booking_id     UUID           REFERENCES bookings(id) ON DELETE SET NULL,
      ticket_number  VARCHAR(50)    NOT NULL UNIQUE,
      category       VARCHAR(50)    NOT NULL,
      subject        VARCHAR(255)   NOT NULL,
      description    TEXT           DEFAULT '',
      priority       VARCHAR(20)    NOT NULL DEFAULT 'MEDIUM',
      status         VARCHAR(30)    NOT NULL DEFAULT 'OPEN',
      resolved_at    TIMESTAMPTZ,
      closed_at      TIMESTAMPTZ,
      created_at     TIMESTAMPTZ    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at     TIMESTAMPTZ    NOT NULL DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT chk_support_tickets_status CHECK (status IN (
        'OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED',
        'open', 'in_progress', 'waiting_for_user', 'waiting_for_customer', 'resolved', 'closed'
      )),
      CONSTRAINT chk_support_tickets_priority CHECK (priority IN (
        'LOW', 'MEDIUM', 'HIGH', 'URGENT',
        'low', 'medium', 'high', 'urgent'
      )),
      CONSTRAINT chk_support_tickets_category CHECK (category IN (
        'BOOKING', 'PAYMENT', 'VEHICLE', 'PARTNER', 'ACCOUNT', 'DOCUMENT', 'TECHNICAL', 'OTHER', 'REFUND',
        'booking', 'payment', 'vehicle', 'partner', 'account', 'document', 'technical', 'other', 'refund'
      ))
    );
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_support_tickets_customer_created
    ON support_tickets (customer_id, created_at DESC);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_support_tickets_customer_status
    ON support_tickets (customer_id, status);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_support_tickets_booking
    ON support_tickets (booking_id)
    WHERE booking_id IS NOT NULL;
  `);

  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_support_tickets_updated_at ON support_tickets;
    CREATE TRIGGER trg_support_tickets_updated_at
    BEFORE UPDATE ON support_tickets
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  pgm.sql('DROP TRIGGER IF EXISTS trg_support_tickets_updated_at ON support_tickets;');
  pgm.sql('DROP TABLE IF EXISTS support_tickets CASCADE;');
};
