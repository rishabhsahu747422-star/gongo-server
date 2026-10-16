'use strict';

/**
 * Migration 036: Add unique constraint on settlement credit reference in wallet_transactions.
 *
 * FINANCIAL INTEGRITY & IDEMPOTENCY:
 *   Guarantees at the database level that a single post-rental settlement payment
 *   cannot be credited to a partner's wallet more than once.
 *   Uses a partial unique index on (reference_type, reference_id) where
 *   reference_type = 'POST_RENTAL_SETTLEMENT' AND direction = 'CREDIT'.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_transactions_settlement_credit
    ON wallet_transactions (reference_type, reference_id)
    WHERE reference_type = 'POST_RENTAL_SETTLEMENT' AND direction = 'CREDIT';
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP INDEX IF EXISTS uq_wallet_transactions_settlement_credit;');
};
