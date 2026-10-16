'use strict';

exports.shorthands = undefined;

/**
 * Migration 050: Partner Payout Requests and Admin Manual Payment Processing
 *
 * Adds manual payout payment fields:
 * - processed_by: Admin user ID who executed the payout
 * - payment_method: Method used (e.g., 'UPI', 'NEFT', 'IMPS', 'BANK_TRANSFER')
 * - payment_reference: External UTR / bank reference number
 * - notes: Optional admin notes
 * Updates partner_payouts status check constraint to support PENDING, PAID, REJECTED along with existing statuses.
 * Updates payouts view.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = async (pgm) => {
  await pgm.sql(`
    -- 1. Add manual payout columns to partner_payouts
    ALTER TABLE partner_payouts ADD COLUMN IF NOT EXISTS processed_by UUID REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE partner_payouts ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50);
    ALTER TABLE partner_payouts ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(100);
    ALTER TABLE partner_payouts ADD COLUMN IF NOT EXISTS notes TEXT;

    -- 2. Expand status check constraint to support pending, paid, rejected alongside legacy statuses
    ALTER TABLE partner_payouts DROP CONSTRAINT IF EXISTS partner_payouts_status_check;
    ALTER TABLE partner_payouts ADD CONSTRAINT partner_payouts_status_check
      CHECK (((status)::text = ANY ((ARRAY[
        'requested'::character varying,
        'pending'::character varying,
        'approved'::character varying,
        'processing'::character varying,
        'completed'::character varying,
        'paid'::character varying,
        'failed'::character varying,
        'rejected'::character varying,
        'cancelled'::character varying
      ])::text[])));

    -- 3. Update compatibility view payouts
    CREATE OR REPLACE VIEW payouts AS
      SELECT
        id,
        partner_id,
        bank_account_id,
        payout_number,
        amount,
        currency,
        status,
        failure_reason,
        requested_at,
        approved_at,
        processed_at,
        completed_at,
        created_at,
        updated_at,
        idempotency_key,
        provider_transfer_id,
        processed_by,
        payment_method,
        payment_reference,
        notes
      FROM partner_payouts;
  `);
};

exports.down = async (pgm) => {
  await pgm.sql(`
    CREATE OR REPLACE VIEW payouts AS
      SELECT
        id,
        partner_id,
        bank_account_id,
        payout_number,
        amount,
        currency,
        status,
        failure_reason,
        requested_at,
        approved_at,
        processed_at,
        completed_at,
        created_at,
        updated_at,
        idempotency_key,
        provider_transfer_id
      FROM partner_payouts;

    ALTER TABLE partner_payouts DROP CONSTRAINT IF EXISTS partner_payouts_status_check;
    ALTER TABLE partner_payouts ADD CONSTRAINT partner_payouts_status_check
      CHECK (((status)::text = ANY ((ARRAY['requested'::character varying, 'approved'::character varying, 'processing'::character varying, 'completed'::character varying, 'failed'::character varying, 'cancelled'::character varying])::text[])));

    ALTER TABLE partner_payouts DROP COLUMN IF EXISTS processed_by;
    ALTER TABLE partner_payouts DROP COLUMN IF EXISTS payment_method;
    ALTER TABLE partner_payouts DROP COLUMN IF EXISTS payment_reference;
    ALTER TABLE partner_payouts DROP COLUMN IF EXISTS notes;
  `);
};
