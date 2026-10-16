'use strict';

/**
 * Migration: Add cancellation policy, refund amount, upi_id, and metadata columns
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    ALTER TABLE booking_cancellations 
      ADD COLUMN IF NOT EXISTS original_paid_amount NUMERIC(10,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(10,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS upi_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS policy_name VARCHAR(100),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

    ALTER TABLE refunds 
      ADD COLUMN IF NOT EXISTS upi_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS original_paid_amount NUMERIC(10,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS refund_percentage NUMERIC(5,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS policy_name VARCHAR(100);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql(`
    ALTER TABLE booking_cancellations 
      DROP COLUMN IF EXISTS original_paid_amount,
      DROP COLUMN IF EXISTS refund_amount,
      DROP COLUMN IF EXISTS upi_id,
      DROP COLUMN IF EXISTS policy_name,
      DROP COLUMN IF EXISTS updated_at;

    ALTER TABLE refunds 
      DROP COLUMN IF EXISTS upi_id,
      DROP COLUMN IF EXISTS original_paid_amount,
      DROP COLUMN IF EXISTS refund_percentage,
      DROP COLUMN IF EXISTS policy_name;
  `);
};
