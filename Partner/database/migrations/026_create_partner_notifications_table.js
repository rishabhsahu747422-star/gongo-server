'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS partner_notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      type VARCHAR(50) NOT NULL,
      title VARCHAR(200) NOT NULL,
      body TEXT NOT NULL,
      payload JSONB,
      read_at TIMESTAMPTZ,
      event_key VARCHAR(100),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_partner_notifications_partner_id
    ON partner_notifications (partner_id);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_partner_notifications_read_at
    ON partner_notifications (read_at);
  `);

  await pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_notifications_event_key
    ON partner_notifications (partner_id, event_key)
    WHERE event_key IS NOT NULL;
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TABLE IF EXISTS partner_notifications CASCADE;');
};
