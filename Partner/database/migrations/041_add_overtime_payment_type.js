'use strict';

/**
 * Migration 041: Add OVERTIME_CHARGE to payments table payment_type constraint.
 *
 * Expands payment_type check constraint to permit:
 * - 'BOOKING_ADVANCE'
 * - 'POST_RENTAL_SETTLEMENT'
 * - 'OVERTIME_CHARGE'
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    ALTER TABLE payments
    DROP CONSTRAINT IF EXISTS chk_payments_type;

    ALTER TABLE payments
    ADD CONSTRAINT chk_payments_type
    CHECK (payment_type IN ('BOOKING_ADVANCE', 'POST_RENTAL_SETTLEMENT', 'OVERTIME_CHARGE'));
  `);
};

exports.down = async (pgm) => {
  await pgm.sql(`
    ALTER TABLE payments
    DROP CONSTRAINT IF EXISTS chk_payments_type;

    ALTER TABLE payments
    ADD CONSTRAINT chk_payments_type
    CHECK (payment_type IN ('BOOKING_ADVANCE', 'POST_RENTAL_SETTLEMENT'));
  `);
};
