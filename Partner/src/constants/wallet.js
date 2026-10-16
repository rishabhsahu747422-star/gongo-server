'use strict';

/**
 * Wallet and transaction domain constants.
 */
const WALLET_TRANSACTION_TYPE = Object.freeze({
  SETTLEMENT_PAYMENT: 'SETTLEMENT_PAYMENT',
  PAYOUT: 'PAYOUT',
  PAYOUT_REVERSAL: 'PAYOUT_REVERSAL',
});

const TRANSACTION_DIRECTION = Object.freeze({
  CREDIT: 'CREDIT',
  DEBIT: 'DEBIT',
});

const TRANSACTION_STATUS = Object.freeze({
  PENDING: 'PENDING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  REVERSED: 'REVERSED',
});

const WALLET_REFERENCE_TYPE = Object.freeze({
  POST_RENTAL_SETTLEMENT: 'POST_RENTAL_SETTLEMENT',
  PAYOUT: 'PAYOUT',
  PAYOUT_REVERSAL: 'PAYOUT_REVERSAL',
});

/**
 * wallet_transactions storage vocabulary.
 *
 * The domain constants above are UPPERCASE, but rows are persisted in the live schema's
 * lowercase vocabulary (direction 'credit'/'debit', transaction_type 'booking_earning'/
 * 'payout'/..., reference_type 'booking'/'payout'/...). Admin's ledger writer uses the same
 * mapping. Every reader must translate through these maps; comparing a column against a
 * domain constant (e.g. reference_type = 'POST_RENTAL_SETTLEMENT') never matches a stored row.
 */
const LEDGER_STORAGE_DIRECTION = Object.freeze({
  CREDIT: 'credit',
  DEBIT: 'debit',
});

const LEDGER_STORAGE_TYPE = Object.freeze({
  SETTLEMENT_PAYMENT: 'booking_earning',
  PAYOUT: 'payout',
  PAYOUT_REVERSAL: 'refund_adjustment',
  BOOKING_EARNING: 'booking_earning',
  REFUND_ADJUSTMENT: 'refund_adjustment',
  ADMIN_ADJUSTMENT: 'admin_adjustment',
  RECEIVABLE_RECOVERY: 'receivable_recovery',
});

const LEDGER_STORAGE_REFERENCE = Object.freeze({
  POST_RENTAL_SETTLEMENT: 'booking',
  PAYOUT: 'payout',
  PAYOUT_REVERSAL: 'refund',
  BOOKING: 'booking',
  REFUND: 'refund',
  ADMIN: 'admin',
});

/**
 * @param {string} direction 'CREDIT' | 'DEBIT' (any case)
 * @returns {'credit'|'debit'}
 * @throws {Error} for any other value — invalid ledger rows must never be written
 */
function toStorageDirection(direction) {
  const stored = LEDGER_STORAGE_DIRECTION[String(direction || '').toUpperCase()];
  if (!stored) {
    throw new Error(`Invalid ledger direction: ${direction}`);
  }
  return stored;
}

function toStorageType(type) {
  if (!type) return null;
  return LEDGER_STORAGE_TYPE[String(type).toUpperCase()] || String(type).toLowerCase();
}

function toStorageReference(referenceType) {
  if (!referenceType) return null;
  return LEDGER_STORAGE_REFERENCE[String(referenceType).toUpperCase()] || String(referenceType).toLowerCase();
}

/**
 * Lowercased values a reader should accept for a domain value: the stored form plus the
 * legacy as-named form, so rows written before the mapping existed still match.
 * Compare with LOWER(column) IN (...).
 *
 * @param {'direction'|'type'|'reference'} kind
 * @param {string} value
 * @returns {string[]}
 */
function ledgerMatchValues(kind, value) {
  if (!value) return [];
  const toStorage = { direction: toStorageDirection, type: toStorageType, reference: toStorageReference }[kind];
  return [...new Set([toStorage(value), String(value).toLowerCase()])];
}

module.exports = {
  WALLET_TRANSACTION_TYPE,
  TRANSACTION_DIRECTION,
  TRANSACTION_STATUS,
  WALLET_REFERENCE_TYPE,
  LEDGER_STORAGE_DIRECTION,
  LEDGER_STORAGE_TYPE,
  LEDGER_STORAGE_REFERENCE,
  toStorageDirection,
  toStorageType,
  toStorageReference,
  ledgerMatchValues,
};
