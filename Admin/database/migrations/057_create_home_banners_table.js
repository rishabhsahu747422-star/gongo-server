'use strict';

/**
 * Migration 057: Create home_banners table for Dynamic Home Banner Management System.
 * Supports static images, animated GIFs, and optional MP4 videos.
 * Features version tracking, content hashing, display ordering, and rich metadata.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS home_banners (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title VARCHAR(255),
      subtitle TEXT,
      tag VARCHAR(100),
      asset_type VARCHAR(20) NOT NULL CHECK (asset_type IN ('IMAGE', 'GIF', 'VIDEO')),
      asset_url TEXT NOT NULL,
      storage_path TEXT,
      version VARCHAR(64) NOT NULL DEFAULT '1',
      content_hash VARCHAR(64),
      is_active BOOLEAN NOT NULL DEFAULT true,
      display_order INTEGER NOT NULL DEFAULT 0,
      cta_label VARCHAR(100),
      cta_destination VARCHAR(255),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_home_banners_active_order
      ON home_banners (is_active, display_order ASC, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_home_banners_updated_at
      ON home_banners (updated_at DESC);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql(`
    DROP INDEX IF EXISTS idx_home_banners_updated_at;
    DROP INDEX IF EXISTS idx_home_banners_active_order;
    DROP TABLE IF EXISTS home_banners CASCADE;
  `);
};
