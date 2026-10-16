'use strict';

/**
 * Migration 045: Reconcile support_tickets and support_ticket_messages for Admin Support & Tickets.
 *
 * DESIGN DECISIONS:
 *   - support_tickets:
 *       - partner_id: Made NULLABLE so support tickets can be opened by
 *         CUSTOMERS, PARTNERS, or directly for BOOKINGS.
 *       - customer_id: Added UUID REFERENCES users(id) ON DELETE SET NULL
 *         to link tickets created by/for customers.
 *       - booking_id: Added UUID REFERENCES bookings(id) ON DELETE SET NULL
 *         to link tickets to specific bookings.
 *       - assigned_to: Added UUID REFERENCES users(id) ON DELETE SET NULL for admin assignment.
 *       - assigned_at: TIMESTAMPTZ for tracking admin assignment timestamp.
 *       - resolved_by: Added UUID REFERENCES users(id) ON DELETE SET NULL.
 *       - resolved_at: TIMESTAMPTZ for tracking resolution timestamp.
 *       - closed_at: TIMESTAMPTZ for tracking ticket closure timestamp.
 *       - resolution_notes: TEXT for resolution notes.
 *       - metadata: JSONB NOT NULL DEFAULT '{}'::jsonb for extensible metadata.
 *       - chk_support_tickets_status: Reconciled to
 *         ('OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED', 'REOPENED').
 *       - chk_support_tickets_priority: ('LOW', 'MEDIUM', 'HIGH', 'URGENT').
 *       - chk_support_tickets_category:
 *         ('BOOKING', 'PAYMENT', 'VEHICLE', 'PARTNER', 'ACCOUNT',
 *          'DOCUMENT', 'TECHNICAL', 'OTHER').
 *   - support_ticket_messages:
 *       - sender_type: Reconciled check constraint to
 *         ('CUSTOMER', 'PARTNER', 'SUPPORT', 'ADMIN', 'SYSTEM').
 *       - attachments: JSONB or TEXT[] compatible.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  // 1. Alter support_tickets to make partner_id NULLABLE
  //    (for customer and general support tickets)
  await pgm.sql(`
    ALTER TABLE support_tickets
    ALTER COLUMN partner_id DROP NOT NULL;
  `);

  // 2. Add customer_id, booking_id, assigned_to, assigned_at,
  //    resolved_by, resolved_at, closed_at, resolution_notes, metadata
  await pgm.sql(`
    ALTER TABLE support_tickets
    ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS resolution_notes TEXT,
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);

  // 3. Reconcile support_tickets status constraint
  await pgm.sql(`
    ALTER TABLE support_tickets
    DROP CONSTRAINT IF EXISTS chk_support_tickets_status;

    ALTER TABLE support_tickets
    ADD CONSTRAINT chk_support_tickets_status
    CHECK (status IN ('OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED', 'REOPENED'));
  `);

  // 4. Reconcile support_tickets priority constraint
  await pgm.sql(`
    ALTER TABLE support_tickets
    DROP CONSTRAINT IF EXISTS chk_support_tickets_priority;

    ALTER TABLE support_tickets
    ADD CONSTRAINT chk_support_tickets_priority
    CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT'));
  `);

  // 5. Reconcile support_tickets category constraint
  await pgm.sql(`
    ALTER TABLE support_tickets
    DROP CONSTRAINT IF EXISTS chk_support_tickets_category;

    ALTER TABLE support_tickets
    ADD CONSTRAINT chk_support_tickets_category
    CHECK (category IN ('BOOKING', 'PAYMENT', 'VEHICLE', 'PARTNER', 'ACCOUNT', 'DOCUMENT', 'TECHNICAL', 'OTHER'));
  `);

  // 6. Reconcile support_ticket_messages sender_type constraint
  await pgm.sql(`
    ALTER TABLE support_ticket_messages
    DROP CONSTRAINT IF EXISTS chk_support_messages_sender_type,
    DROP CONSTRAINT IF EXISTS chk_support_ticket_messages_sender_type;

    ALTER TABLE support_ticket_messages
    ADD CONSTRAINT chk_support_messages_sender_type
    CHECK (sender_type IN ('CUSTOMER', 'PARTNER', 'SUPPORT', 'ADMIN', 'SYSTEM'));
  `);

  // 7. Add performance indexes for Admin support searches and relationships
  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_support_tickets_customer_id ON support_tickets (customer_id);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_booking_id ON support_tickets (booking_id);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_assigned_to ON support_tickets (assigned_to);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_category ON support_tickets (category);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_priority ON support_tickets (priority);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_created_at ON support_tickets (created_at DESC);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP INDEX IF EXISTS idx_support_tickets_created_at;');
  await pgm.sql('DROP INDEX IF EXISTS idx_support_tickets_priority;');
  await pgm.sql('DROP INDEX IF EXISTS idx_support_tickets_category;');
  await pgm.sql('DROP INDEX IF EXISTS idx_support_tickets_assigned_to;');
  await pgm.sql('DROP INDEX IF EXISTS idx_support_tickets_booking_id;');
  await pgm.sql('DROP INDEX IF EXISTS idx_support_tickets_customer_id;');

  await pgm.sql(`
    ALTER TABLE support_ticket_messages
    DROP CONSTRAINT IF EXISTS chk_support_messages_sender_type;

    ALTER TABLE support_ticket_messages
    ADD CONSTRAINT chk_support_messages_sender_type
    CHECK (sender_type IN ('PARTNER', 'SUPPORT', 'SYSTEM'));
  `);

  await pgm.sql(`
    ALTER TABLE support_tickets
    DROP CONSTRAINT IF EXISTS chk_support_tickets_category;

    ALTER TABLE support_tickets
    DROP CONSTRAINT IF EXISTS chk_support_tickets_priority;

    ALTER TABLE support_tickets
    ADD CONSTRAINT chk_support_tickets_priority
    CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT'));

    ALTER TABLE support_tickets
    DROP CONSTRAINT IF EXISTS chk_support_tickets_status;

    ALTER TABLE support_tickets
    ADD CONSTRAINT chk_support_tickets_status
    CHECK (status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'));
  `);

  await pgm.sql(`
    ALTER TABLE support_tickets
    DROP COLUMN IF EXISTS metadata,
    DROP COLUMN IF EXISTS resolution_notes,
    DROP COLUMN IF EXISTS closed_at,
    DROP COLUMN IF EXISTS resolved_at,
    DROP COLUMN IF EXISTS resolved_by,
    DROP COLUMN IF EXISTS assigned_at,
    DROP COLUMN IF EXISTS assigned_to,
    DROP COLUMN IF EXISTS booking_id,
    DROP COLUMN IF EXISTS customer_id;
  `);

  await pgm.sql(`
    ALTER TABLE support_tickets
    ALTER COLUMN partner_id SET NOT NULL;
  `);
};
