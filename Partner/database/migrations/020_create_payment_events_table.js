'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS payment_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider VARCHAR(30) NOT NULL DEFAULT 'CASHFREE',
      event_id VARCHAR(100) NOT NULL,
      event_type VARCHAR(100) NOT NULL,
      payload JSONB NOT NULL,
      is_processed BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_payment_events_event_id UNIQUE (provider, event_id),
      CONSTRAINT chk_payment_events_provider CHECK (provider IN ('CASHFREE'))
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_payment_events_lookup
    ON payment_events (provider, event_id);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TABLE IF EXISTS payment_events CASCADE;');
};
