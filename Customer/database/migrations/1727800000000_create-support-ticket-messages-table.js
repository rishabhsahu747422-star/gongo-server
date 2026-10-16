'use strict';

/**
 * Migration: Create support_ticket_messages table.
 *
 * DESIGN DECISIONS:
 *   - ticket_id references support_tickets(id) ON DELETE CASCADE.
 *   - sender_type: CUSTOMER, SUPPORT.
 *   - sender_id: UUID of customer or support agent.
 *   - message: TEXT NOT NULL.
 *   - attachments: JSONB array of attachment objects [{ url, filename, mimeType, size }].
 *   - Index on (ticket_id, created_at ASC) for chronological conversation history.
 */

exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS support_ticket_messages (
      id           UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_id    UUID           NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
      sender_type  VARCHAR(20)    NOT NULL,
      sender_id    UUID           NOT NULL,
      message      TEXT           NOT NULL,
      attachments  JSONB          NOT NULL DEFAULT '[]'::jsonb,
      created_at   TIMESTAMPTZ    NOT NULL DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT chk_support_ticket_messages_sender_type CHECK (sender_type IN ('CUSTOMER', 'SUPPORT'))
    );
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_ticket_created
    ON support_ticket_messages (ticket_id, created_at ASC);
  `);
};

exports.down = async (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS support_ticket_messages CASCADE;');
};
