'use strict';

/**
 * Migration 042: Reconcile support_tickets and support_ticket_messages constraints for Partner support flow.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    ALTER TABLE support_tickets
    DROP CONSTRAINT IF EXISTS chk_support_tickets_category;

    ALTER TABLE support_tickets
    ADD CONSTRAINT chk_support_tickets_category
    CHECK (upper(category::text) = ANY (ARRAY['BOOKING', 'PAYMENT', 'PAYOUT', 'REFUND', 'VEHICLE', 'DAMAGE', 'PARTNER', 'ACCOUNT', 'DOCUMENT', 'TECHNICAL', 'OTHER']));
  `);

  await pgm.sql(`
    ALTER TABLE support_tickets
    DROP CONSTRAINT IF EXISTS chk_support_tickets_status;

    ALTER TABLE support_tickets
    ADD CONSTRAINT chk_support_tickets_status
    CHECK (upper(status::text) = ANY (ARRAY['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'WAITING_FOR_USER', 'RESOLVED', 'CLOSED', 'REOPENED']));
  `);

  await pgm.sql(`
    ALTER TABLE support_tickets
    DROP CONSTRAINT IF EXISTS chk_support_tickets_priority;

    ALTER TABLE support_tickets
    ADD CONSTRAINT chk_support_tickets_priority
    CHECK (upper(priority::text) = ANY (ARRAY['LOW', 'MEDIUM', 'HIGH', 'URGENT']));
  `);
};

exports.down = async (pgm) => {
  // Safe rollback preserves existing constraints
  await pgm.sql(`
    ALTER TABLE support_tickets
    DROP CONSTRAINT IF EXISTS chk_support_tickets_category;

    ALTER TABLE support_tickets
    ADD CONSTRAINT chk_support_tickets_category
    CHECK (upper(category::text) = ANY (ARRAY['BOOKING', 'PAYMENT', 'REFUND', 'VEHICLE', 'PARTNER', 'ACCOUNT', 'DOCUMENT', 'TECHNICAL', 'OTHER']));
  `);
};
