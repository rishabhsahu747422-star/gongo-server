'use strict';

/**
 * Migration 046: Reconcile notifications table and create notification_templates table.
 *
 * DESIGN DECISIONS:
 *   - notification_templates:
 *       - template_key: Unique identifier string for programmatic dispatch.
 *       - title, body: Support variable substitution placeholders (e.g. {{customerName}}).
 *       - channel: ('PUSH', 'IN_APP', 'SMS', 'EMAIL').
 *       - target_audience: ('CUSTOMER', 'PARTNER', 'ALL').
 *       - variables: JSONB array of permitted template variable keys.
 *   - notifications:
 *       - customer_id: Made NULLABLE so notifications can target partners or general topics.
 *       - partner_id: Added UUID REFERENCES partners(id) ON DELETE CASCADE.
 *       - recipient_type: ('CUSTOMER', 'PARTNER').
 *       - channel: ('PUSH', 'IN_APP', 'SMS', 'EMAIL').
 *       - template_id: REFERENCES notification_templates(id) ON DELETE SET NULL.
 *       - booking_id: REFERENCES bookings(id) ON DELETE SET NULL.
 *       - sent_by: REFERENCES users(id) ON DELETE SET NULL (admin operator).
 *       - status: Reconciled to ('PENDING', 'SENT', 'DELIVERED', 'FAILED').
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  // 1. Create notification_templates table
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS notification_templates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      template_key VARCHAR(100) NOT NULL UNIQUE,
      title VARCHAR(255) NOT NULL,
      body TEXT NOT NULL,
      notification_type VARCHAR(50) NOT NULL,
      channel VARCHAR(30) NOT NULL DEFAULT 'PUSH',
      target_audience VARCHAR(20) NOT NULL DEFAULT 'ALL',
      is_active BOOLEAN NOT NULL DEFAULT true,
      variables JSONB NOT NULL DEFAULT '[]'::jsonb,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_notification_templates_channel
        CHECK (channel IN ('PUSH', 'IN_APP', 'SMS', 'EMAIL')),
      CONSTRAINT chk_notification_templates_target
        CHECK (target_audience IN ('CUSTOMER', 'PARTNER', 'ALL'))
    );

    ALTER TABLE notification_templates
      ADD COLUMN IF NOT EXISTS template_key VARCHAR(100),
      ADD COLUMN IF NOT EXISTS title VARCHAR(255),
      ADD COLUMN IF NOT EXISTS body TEXT,
      ADD COLUMN IF NOT EXISTS target_audience VARCHAR(20) DEFAULT 'ALL',
      ADD COLUMN IF NOT EXISTS variables JSONB DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_notification_templates_key
    ON notification_templates (template_key);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_notification_templates_type
    ON notification_templates (notification_type);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_notification_templates_active
    ON notification_templates (is_active);
  `);

  // 2. Ensure notifications table exists (if running in test environments where
  //    only Partner migrations were seeded)
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id UUID REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      body TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
      read_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      failure_reason TEXT,
      event_key VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 3. Reconcile notifications table columns
  await pgm.sql(`
    ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES users(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS partner_id UUID REFERENCES partners(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS recipient_type VARCHAR(20) NOT NULL DEFAULT 'CUSTOMER',
    ADD COLUMN IF NOT EXISTS channel VARCHAR(30) NOT NULL DEFAULT 'PUSH',
    ADD COLUMN IF NOT EXISTS template_id UUID REFERENCES notification_templates(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS sent_by UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    ADD COLUMN IF NOT EXISTS body TEXT,
    ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS failure_reason TEXT,
    ADD COLUMN IF NOT EXISTS event_key VARCHAR(255),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

    ALTER TABLE notifications
    ALTER COLUMN customer_id DROP NOT NULL;
  `);

  // 4. Drop restrictive type check and reconcile status/channel constraints
  await pgm.sql(`
    ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS chk_notifications_type;

    ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS chk_notifications_status;

    ALTER TABLE notifications
    ADD CONSTRAINT chk_notifications_status
    CHECK (status IN ('PENDING', 'SENT', 'DELIVERED', 'FAILED'));

    ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS chk_notifications_recipient_type;

    ALTER TABLE notifications
    ADD CONSTRAINT chk_notifications_recipient_type
    CHECK (recipient_type IN ('CUSTOMER', 'PARTNER'));

    ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS chk_notifications_channel;

    ALTER TABLE notifications
    ADD CONSTRAINT chk_notifications_channel
    CHECK (channel IN ('PUSH', 'IN_APP', 'SMS', 'EMAIL'));
  `);

  // 5. Indexes for performant filtering
  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_notifications_partner_id
    ON notifications (partner_id);

    CREATE INDEX IF NOT EXISTS idx_notifications_template_id
    ON notifications (template_id);

    CREATE INDEX IF NOT EXISTS idx_notifications_booking_id
    ON notifications (booking_id);

    CREATE INDEX IF NOT EXISTS idx_notifications_recipient_type
    ON notifications (recipient_type);

    CREATE INDEX IF NOT EXISTS idx_notifications_status
    ON notifications (status);

    CREATE INDEX IF NOT EXISTS idx_notifications_channel
    ON notifications (channel);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql(`
    DROP INDEX IF EXISTS idx_notifications_channel;
    DROP INDEX IF EXISTS idx_notifications_status;
    DROP INDEX IF EXISTS idx_notifications_recipient_type;
    DROP INDEX IF EXISTS idx_notifications_booking_id;
    DROP INDEX IF EXISTS idx_notifications_template_id;
    DROP INDEX IF EXISTS idx_notifications_partner_id;

    ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS chk_notifications_channel;

    ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS chk_notifications_recipient_type;

    ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS chk_notifications_status;

    ALTER TABLE notifications
    ADD CONSTRAINT chk_notifications_status
    CHECK (status IN ('PENDING', 'SENT', 'FAILED'));

    ALTER TABLE notifications
    DROP COLUMN IF EXISTS metadata,
    DROP COLUMN IF EXISTS sent_by,
    DROP COLUMN IF EXISTS booking_id,
    DROP COLUMN IF EXISTS template_id,
    DROP COLUMN IF EXISTS channel,
    DROP COLUMN IF EXISTS recipient_type,
    DROP COLUMN IF EXISTS partner_id;

    DROP TABLE IF EXISTS notification_templates CASCADE;
    DROP TABLE IF EXISTS notifications CASCADE;
  `);
};
