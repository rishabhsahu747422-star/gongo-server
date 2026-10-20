'use strict';

/**
 * Migration 058: Enhance offers table for Dynamic Offers Management System.
 * Supports promo code, media images, display priority, CTA routing, and metadata.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    -- Ensure offers table exists (with canonical schema)
    CREATE TABLE IF NOT EXISTS offers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      description TEXT,
      offer_type VARCHAR(50) NOT NULL DEFAULT 'discount',
      discount_type VARCHAR(20) DEFAULT 'percentage',
      discount_value NUMERIC(12,2),
      max_discount_amount NUMERIC(12,2),
      valid_from TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      valid_until TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '90 days'),
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Add dynamic offer extensions
    ALTER TABLE offers ADD COLUMN IF NOT EXISTS code VARCHAR(50);
    ALTER TABLE offers ADD COLUMN IF NOT EXISTS image_url TEXT;
    ALTER TABLE offers ADD COLUMN IF NOT EXISTS storage_path TEXT;
    ALTER TABLE offers ADD COLUMN IF NOT EXISTS min_booking_amount NUMERIC(12,2) DEFAULT 0.00;
    ALTER TABLE offers ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE offers ADD COLUMN IF NOT EXISTS cta_label VARCHAR(100);
    ALTER TABLE offers ADD COLUMN IF NOT EXISTS cta_destination VARCHAR(255);
    ALTER TABLE offers ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

    -- Create performance indexes for active customer offer querying
    CREATE INDEX IF NOT EXISTS idx_offers_active_dates_order
      ON offers (is_active, display_order ASC, valid_from ASC, valid_until DESC);

    CREATE INDEX IF NOT EXISTS idx_offers_code
      ON offers (UPPER(code)) WHERE code IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_offers_updated_at
      ON offers (updated_at DESC);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql(`
    DROP INDEX IF EXISTS idx_offers_updated_at;
    DROP INDEX IF EXISTS idx_offers_code;
    DROP INDEX IF EXISTS idx_offers_active_dates_order;
    ALTER TABLE offers DROP COLUMN IF EXISTS metadata;
    ALTER TABLE offers DROP COLUMN IF EXISTS cta_destination;
    ALTER TABLE offers DROP COLUMN IF EXISTS cta_label;
    ALTER TABLE offers DROP COLUMN IF EXISTS display_order;
    ALTER TABLE offers DROP COLUMN IF EXISTS min_booking_amount;
    ALTER TABLE offers DROP COLUMN IF EXISTS storage_path;
    ALTER TABLE offers DROP COLUMN IF EXISTS image_url;
    ALTER TABLE offers DROP COLUMN IF EXISTS code;
  `);
};
