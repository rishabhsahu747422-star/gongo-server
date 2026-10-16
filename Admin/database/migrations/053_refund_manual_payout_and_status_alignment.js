'use strict';

exports.shorthands = undefined;

/**
 * Migration 053: Refunds Manual Payout Fields, UTR, and Status Constraint Alignment
 *
 * Adds manual refund payment fields:
 * - utr: External bank/UPI transaction reference number
 * - payment_method: Method used ('GATEWAY', 'MANUAL', 'UPI', 'NEFT', 'IMPS', etc.)
 * - notes: Admin remarks / payout notes
 *
 * Aligns refunds_status_check constraint to case-insensitively support:
 * - 'requested', 'under_review', 'approved', 'processing', 'completed', 'paid', 'failed', 'cancelled', 'partial', 'rejected'
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = async (pgm) => {
  await pgm.sql(`
    -- 1. Add manual refund columns to refunds
    ALTER TABLE refunds ADD COLUMN IF NOT EXISTS utr VARCHAR(100);
    ALTER TABLE refunds ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50) DEFAULT 'GATEWAY';
    ALTER TABLE refunds ADD COLUMN IF NOT EXISTS notes TEXT;

    -- 2. Expand status check constraint to support case-insensitive statuses including rejected and paid
    ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_status_check;
    ALTER TABLE refunds DROP CONSTRAINT IF EXISTS chk_refunds_status;
    ALTER TABLE refunds ADD CONSTRAINT refunds_status_check
      CHECK (lower(status) IN (
        'requested',
        'under_review',
        'approved',
        'processing',
        'completed',
        'paid',
        'failed',
        'cancelled',
        'partial',
        'rejected'
      ));
  `);
};

exports.down = async (pgm) => {
  await pgm.sql(`
    ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_status_check;
    ALTER TABLE refunds ADD CONSTRAINT refunds_status_check
      CHECK (((status)::text = ANY ((ARRAY[
        'requested'::character varying,
        'approved'::character varying,
        'processing'::character varying,
        'completed'::character varying,
        'failed'::character varying,
        'cancelled'::character varying,
        'partial'::character varying
      ])::text[])));

    ALTER TABLE refunds DROP COLUMN IF EXISTS utr;
    ALTER TABLE refunds DROP COLUMN IF EXISTS payment_method;
    ALTER TABLE refunds DROP COLUMN IF EXISTS notes;
  `);
};
