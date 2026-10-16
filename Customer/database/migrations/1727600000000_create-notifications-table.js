'use strict';

/**
 * Migration: Create notifications table for in-app history and push delivery tracking.
 *
 * DESIGN DECISIONS:
 *   - `customer_id` references users(id) ON DELETE CASCADE.
 *   - `status`: PENDING, SENT, FAILED (FCM push delivery status).
 *   - `read_at`: Separate timestamp indicating user read status (NULL = unread).
 *   - `event_key`: Unique business event key for deduplication across retries.
 *   - Indexes: customer_id + created_at for fast descending pagination, unread queries.
 */

exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS notifications (
      id              UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id     UUID           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type            VARCHAR(50)    NOT NULL,
      title           VARCHAR(255)   NOT NULL,
      body            TEXT           NOT NULL,
      data            JSONB          NOT NULL DEFAULT '{}'::jsonb,
      status          VARCHAR(30)    NOT NULL DEFAULT 'PENDING',
      read_at         TIMESTAMPTZ,
      sent_at         TIMESTAMPTZ,
      failure_reason  TEXT,
      event_key       VARCHAR(255),
      created_at      TIMESTAMPTZ    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      TIMESTAMPTZ    NOT NULL DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT chk_notifications_status CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
      CONSTRAINT chk_notifications_type CHECK (type IN (
        'BOOKING_CREATED', 'BOOKING_CONFIRMED', 'BOOKING_CANCELLED',
        'BOOKING_STARTED', 'BOOKING_COMPLETED', 'BOOKING_REMINDER',
        'PAYMENT_PENDING', 'PAYMENT_SUCCESS', 'PAYMENT_FAILED',
        'ACCOUNT_UPDATE', 'DOCUMENT_STATUS_UPDATED'
      ))
    );
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_notifications_customer_created
    ON notifications (customer_id, created_at DESC);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_notifications_customer_read
    ON notifications (customer_id, read_at);
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_notifications_customer_status
    ON notifications (customer_id, status);
  `);

  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_event_key
    ON notifications (event_key)
    WHERE event_key IS NOT NULL;
  `);

  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_notifications_updated_at ON notifications;
    CREATE TRIGGER trg_notifications_updated_at
    BEFORE UPDATE ON notifications
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  pgm.sql('DROP TRIGGER IF EXISTS trg_notifications_updated_at ON notifications;');
  pgm.sql('DROP TABLE IF EXISTS notifications CASCADE;');
};
