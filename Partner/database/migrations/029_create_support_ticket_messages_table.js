'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS support_ticket_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
      sender_type VARCHAR(20) NOT NULL,
      sender_id UUID,
      message TEXT NOT NULL,
      attachments TEXT[],
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_support_messages_sender_type CHECK (sender_type IN ('PARTNER', 'SUPPORT', 'SYSTEM'))
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_support_messages_ticket_id
    ON support_ticket_messages (ticket_id);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TABLE IF EXISTS support_ticket_messages CASCADE;');
};
