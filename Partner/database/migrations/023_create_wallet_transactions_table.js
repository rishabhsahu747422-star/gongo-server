'use strict';

/**
 * Migration: Create immutable wallet transaction ledger.
 *
 * FINANCIAL INTEGRITY:
 *   Every financial change to a Partner's wallet MUST have a corresponding
 *   immutable ledger transaction entry.
 *   Transactions are strictly append-only (no updates, no deletions).
 *   Money columns use NUMERIC(12,2).
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
      partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
      transaction_type VARCHAR(30) NOT NULL,
      direction VARCHAR(10) NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      balance_after NUMERIC(12,2) NOT NULL,
      reference_type VARCHAR(50) NOT NULL,
      reference_id VARCHAR(100) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'COMPLETED',
      description TEXT,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_wallet_tx_direction CHECK (direction IN ('CREDIT', 'DEBIT')),
      CONSTRAINT chk_wallet_tx_amount CHECK (amount > 0.00),
      CONSTRAINT chk_wallet_tx_balance_after CHECK (balance_after >= 0.00),
      CONSTRAINT chk_wallet_tx_status CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED', 'REVERSED'))
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_wallet_id
    ON wallet_transactions (wallet_id);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_partner_id
    ON wallet_transactions (partner_id);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_reference
    ON wallet_transactions (reference_type, reference_id);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_created_at
    ON wallet_transactions (created_at DESC);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TABLE IF EXISTS wallet_transactions CASCADE;');
};
