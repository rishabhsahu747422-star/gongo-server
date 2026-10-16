'use strict';

/**
 * Migration: Add SUPPORT_REPLY notification type to notifications table check constraint.
 */

exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.sql(`
    ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS chk_notifications_type;

    ALTER TABLE notifications
    ADD CONSTRAINT chk_notifications_type CHECK (type IN (
      'BOOKING_CREATED', 'BOOKING_CONFIRMED', 'BOOKING_CANCELLED',
      'BOOKING_STARTED', 'BOOKING_COMPLETED', 'BOOKING_REMINDER',
      'PAYMENT_PENDING', 'PAYMENT_SUCCESS', 'PAYMENT_FAILED',
      'ACCOUNT_UPDATE', 'DOCUMENT_STATUS_UPDATED', 'SUPPORT_REPLY'
    ));
  `);
};

exports.down = async (pgm) => {
  pgm.sql(`
    ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS chk_notifications_type;

    ALTER TABLE notifications
    ADD CONSTRAINT chk_notifications_type CHECK (type IN (
      'BOOKING_CREATED', 'BOOKING_CONFIRMED', 'BOOKING_CANCELLED',
      'BOOKING_STARTED', 'BOOKING_COMPLETED', 'BOOKING_REMINDER',
      'PAYMENT_PENDING', 'PAYMENT_SUCCESS', 'PAYMENT_FAILED',
      'ACCOUNT_UPDATE', 'DOCUMENT_STATUS_UPDATED'
    ));
  `);
};
