'use strict';

/**
 * Migration 047: Add outbox event locking, lease recovery, and worker tracking columns.
 *
 * Requirements (Phase 20 - Reliability & Background Jobs):
 * - worker identifier (locked_by)
 * - claimed timestamp (locked_at)
 * - non-destructive additions to canonical outbox_events table
 * - optimized indexes for pending/retryable claims and stale processing recovery
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    ALTER TABLE outbox_events
    ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS locked_by VARCHAR(128);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_outbox_events_claim
    ON outbox_events (status, next_retry_at, created_at)
    WHERE status IN ('PENDING', 'FAILED');
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_outbox_events_stale
    ON outbox_events (status, locked_at)
    WHERE status = 'PROCESSING';
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP INDEX IF EXISTS idx_outbox_events_stale;');
  await pgm.sql('DROP INDEX IF EXISTS idx_outbox_events_claim;');
  await pgm.sql(`
    ALTER TABLE outbox_events
    DROP COLUMN IF EXISTS locked_by,
    DROP COLUMN IF EXISTS locked_at;
  `);
};
