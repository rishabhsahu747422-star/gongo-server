'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
      ticket_number VARCHAR(50) NOT NULL,
      category VARCHAR(50) NOT NULL DEFAULT 'OTHER',
      subject VARCHAR(200) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'OPEN',
      priority VARCHAR(20) NOT NULL DEFAULT 'MEDIUM',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_support_tickets_number UNIQUE (ticket_number),
      CONSTRAINT chk_support_tickets_status CHECK (status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED')),
      CONSTRAINT chk_support_tickets_priority CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT'))
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_support_tickets_partner_id
    ON support_tickets (partner_id);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_support_tickets_status
    ON support_tickets (status);
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_support_tickets_updated_at ON support_tickets;
    CREATE TRIGGER trg_support_tickets_updated_at
    BEFORE UPDATE ON support_tickets
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TRIGGER IF EXISTS trg_support_tickets_updated_at ON support_tickets;');
  await pgm.sql('DROP TABLE IF EXISTS support_tickets CASCADE;');
};
