'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS outbox_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type VARCHAR(64) NOT NULL,
      aggregate_type VARCHAR(64) NOT NULL,
      aggregate_id VARCHAR(128) NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 5,
      next_retry_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_error TEXT,
      processed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_outbox_events_status_next_retry
    ON outbox_events (status, next_retry_at)
    WHERE status IN ('PENDING', 'FAILED');
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_outbox_events_aggregate
    ON outbox_events (aggregate_type, aggregate_id);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TABLE IF EXISTS outbox_events CASCADE;');
};
