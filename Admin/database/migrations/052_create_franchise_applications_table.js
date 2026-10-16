'use strict';

/**
 * Migration: Create franchise_applications table for tracking territory partner applications.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS franchise_applications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      applicant_name VARCHAR(150) NOT NULL,
      phone VARCHAR(20) NOT NULL,
      email VARCHAR(150) NOT NULL,
      city VARCHAR(100) NOT NULL,
      state VARCHAR(100),
      investment_capacity VARCHAR(50),
      business_experience VARCHAR(50),
      message TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'in_review', 'approved', 'rejected', 'closed')),
      admin_notes TEXT,
      reviewed_by UUID,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_franchise_applications_status
    ON franchise_applications (status);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_franchise_applications_created_at
    ON franchise_applications (created_at DESC);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_franchise_applications_email
    ON franchise_applications (email);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_franchise_applications_phone
    ON franchise_applications (phone);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_franchise_applications_city
    ON franchise_applications (city);
  `);
};

exports.down = async (pgm) => {
  await pgm.sql(`
    DROP TABLE IF EXISTS franchise_applications CASCADE;
  `);
};
