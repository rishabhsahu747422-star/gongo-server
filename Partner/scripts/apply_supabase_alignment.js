'use strict';
require('dotenv').config();
const pool = require('../src/db/pool');

/**
 * Idempotent Master Alignment Runner for Supabase PostgreSQL.
 * Safely provisions all views, additive columns, and partner-specific tables
 * without dropping or modifying existing data or tables.
 */
async function applyAlignment() {
  console.log('Applying Master Supabase Database Schema Alignment...');

  const ddlStatements = [
    // 1. Users compatibility
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_id VARCHAR(128);`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(50) DEFAULT 'supabase';`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(255);`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS country_code VARCHAR(10) DEFAULT '+91';`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_auth_id ON users(auth_id) WHERE auth_id IS NOT NULL;`,

    // 2. Partners compatibility
    `ALTER TABLE partners ADD COLUMN IF NOT EXISTS partner_status VARCHAR(50) DEFAULT 'ACTIVE';`,
    `ALTER TABLE partners ADD COLUMN IF NOT EXISTS business_address TEXT;`,
    `ALTER TABLE partners ADD COLUMN IF NOT EXISTS city VARCHAR(100);`,
    `ALTER TABLE partners ADD COLUMN IF NOT EXISTS latitude NUMERIC(10,8);`,
    `ALTER TABLE partners ADD COLUMN IF NOT EXISTS longitude NUMERIC(11,8);`,
    `ALTER TABLE partners ADD COLUMN IF NOT EXISTS operating_info TEXT DEFAULT '08:00 AM - 10:00 PM (All Days)';`,
    `ALTER TABLE partners ADD COLUMN IF NOT EXISTS profile_image_url TEXT;`,
    `ALTER TABLE partners ADD COLUMN IF NOT EXISTS rating NUMERIC(3,2) DEFAULT 5.0;`,
    `ALTER TABLE partners ADD COLUMN IF NOT EXISTS review_count INTEGER DEFAULT 0;`,
    `ALTER TABLE partners ADD COLUMN IF NOT EXISTS registered_since VARCHAR(50);`,
    `ALTER TABLE partners ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;`,

    // 2b. Vehicles compatibility
    `ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS transmission VARCHAR(50) DEFAULT 'Manual';`,
    `ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS seats INTEGER DEFAULT 2;`,
    `ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS description TEXT;`,
    `ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS pickup_location TEXT;`,
    `ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false;`,
    `ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS offline_reason TEXT;`,
    `ALTER TABLE vehicles ALTER COLUMN model_id DROP NOT NULL;`,
    `ALTER TABLE vehicle_pricing ALTER COLUMN pricing_type DROP NOT NULL;`,
    `ALTER TABLE vehicle_pricing ALTER COLUMN price DROP NOT NULL;`,
    `ALTER TABLE partner_documents ALTER COLUMN file_url DROP NOT NULL;`,
    `ALTER TABLE vehicle_pricing_history ALTER COLUMN effective_from SET DEFAULT CURRENT_TIMESTAMP;`,
    `ALTER TABLE vehicle_pricing_history ADD COLUMN IF NOT EXISTS extra_km_charge NUMERIC DEFAULT 0;`,
    `ALTER TABLE vehicle_pricing_history ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;`,
    `ALTER TABLE vehicle_pricing_history ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ;`,
    `ALTER TABLE vehicle_images ADD COLUMN IF NOT EXISTS image_url TEXT;`,
    `ALTER TABLE vehicle_images ALTER COLUMN file_url DROP NOT NULL;`,
    `ALTER TABLE vehicle_images ALTER COLUMN storage_path DROP NOT NULL;`,
    `ALTER TABLE vehicle_images ALTER COLUMN image_type DROP NOT NULL;`,
    `ALTER TABLE vehicle_images ALTER COLUMN display_order DROP NOT NULL;`,
    `ALTER TABLE vehicle_images ALTER COLUMN is_primary DROP NOT NULL;`,
    `ALTER TABLE vehicle_availability_blocks ALTER COLUMN partner_id DROP NOT NULL;`,
    `ALTER TABLE vehicle_documents ADD COLUMN IF NOT EXISTS document_name VARCHAR(100);`,
    `ALTER TABLE vehicle_documents ADD COLUMN IF NOT EXISTS valid_till DATE;`,
    `ALTER TABLE vehicle_documents ADD COLUMN IF NOT EXISTS storage_key TEXT;`,
    `ALTER TABLE vehicle_documents ADD COLUMN IF NOT EXISTS is_required BOOLEAN DEFAULT false;`,
    `ALTER TABLE vehicle_documents ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;`,
    `ALTER TABLE vehicle_documents ALTER COLUMN file_url DROP NOT NULL;`,
    `ALTER TABLE vehicle_documents ALTER COLUMN storage_path DROP NOT NULL;`,
    `ALTER TABLE vehicle_documents ALTER COLUMN uploaded_at SET DEFAULT CURRENT_TIMESTAMP;`,
    `ALTER TABLE vehicle_documents DROP CONSTRAINT IF EXISTS vehicle_documents_verification_status_check;`,
    `ALTER TABLE vehicle_documents ADD CONSTRAINT vehicle_documents_verification_status_check CHECK (lower((verification_status)::text) = ANY (ARRAY['pending'::text, 'under_review'::text, 'verified'::text, 'rejected'::text, 'expired'::text]));`,

    // 3. Shops compatibility
    `ALTER TABLE shops ADD COLUMN IF NOT EXISTS shop_name VARCHAR(255);`,
    `ALTER TABLE shops ADD COLUMN IF NOT EXISTS shop_address TEXT;`,
    `ALTER TABLE shops ADD COLUMN IF NOT EXISTS city VARCHAR(100);`,
    `ALTER TABLE shops ADD COLUMN IF NOT EXISTS operating_info TEXT DEFAULT '08:00 AM - 10:00 PM (All Days)';`,
    `UPDATE shops SET shop_name = name WHERE shop_name IS NULL;`,
    `UPDATE shops SET shop_address = address_line1 WHERE shop_address IS NULL;`,

    // 4. Partner Bank Accounts compatibility
    `ALTER TABLE partner_bank_accounts ADD COLUMN IF NOT EXISTS account_number_masked VARCHAR(50);`,
    `ALTER TABLE partner_bank_accounts ADD COLUMN IF NOT EXISTS account_number_encrypted TEXT;`,
    `ALTER TABLE partner_bank_accounts ADD COLUMN IF NOT EXISTS verification_status VARCHAR(50) DEFAULT 'PENDING';`,
    `ALTER TABLE partner_bank_accounts ALTER COLUMN account_number DROP NOT NULL;`,

    // 5. Wallet Transactions compatibility
    `ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'COMPLETED';`,
    `ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;`,

    // 6. Payments compatibility
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_type VARCHAR(50) DEFAULT 'RENTAL';`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_order_id VARCHAR(255);`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_payment_id VARCHAR(255);`,

    // 7. Outbox events
    `CREATE TABLE IF NOT EXISTS outbox_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type VARCHAR(100) NOT NULL,
      aggregate_type VARCHAR(100) NOT NULL,
      aggregate_id VARCHAR(100) NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 5,
      last_error TEXT,
      next_retry_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      processed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,
    `ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;`,
    `CREATE INDEX IF NOT EXISTS idx_outbox_events_status_next_retry ON outbox_events(status, next_retry_at);`,

    // 8. Storage uploads & Payment events
    `CREATE TABLE IF NOT EXISTS storage_uploads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      entity_type VARCHAR(50) NOT NULL,
      entity_id UUID NOT NULL,
      document_type VARCHAR(50),
      storage_key TEXT NOT NULL UNIQUE,
      content_type VARCHAR(100) NOT NULL,
      expected_size_bytes BIGINT,
      actual_size_bytes BIGINT,
      status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
      expires_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,
    `CREATE INDEX IF NOT EXISTS idx_storage_uploads_partner ON storage_uploads(partner_id, status);`,

    `CREATE TABLE IF NOT EXISTS payment_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id VARCHAR(255) NOT NULL UNIQUE,
      event_type VARCHAR(100) NOT NULL,
      provider VARCHAR(50) NOT NULL DEFAULT 'CASHFREE',
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      processed BOOLEAN NOT NULL DEFAULT false,
      processed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,
    `CREATE INDEX IF NOT EXISTS idx_payment_events_event_id ON payment_events(event_id);`,

    // 9. Partner Payouts compatibility
    `ALTER TABLE partner_payouts ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);`,
    `ALTER TABLE partner_payouts ADD COLUMN IF NOT EXISTS provider_transfer_id VARCHAR(255);`,
    `ALTER TABLE partner_payouts ALTER COLUMN payout_number SET DEFAULT ('PO-' || upper(substr(gen_random_uuid()::text, 1, 8)));`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_payouts_idempotency ON partner_payouts(partner_id, idempotency_key) WHERE idempotency_key IS NOT NULL;`,

    // 10. Canonical views
    `CREATE OR REPLACE VIEW wallets AS
     SELECT
       id,
       partner_id,
       available_balance,
       pending_balance,
       total_credited,
       total_debited,
       currency,
       created_at,
       updated_at
     FROM partner_wallets;`,

    `CREATE OR REPLACE VIEW payouts AS
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
     FROM partner_payouts;`,

    // 11. Support messages compatibility
    `ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS sender_type VARCHAR(50) DEFAULT 'PARTNER';`,
    `ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS attachments JSONB;`,
    `CREATE OR REPLACE VIEW support_ticket_messages AS
     SELECT
       id,
       ticket_id,
       sender_type,
       sender_id,
       message,
       attachments,
       is_internal,
       created_at
     FROM support_messages;`,

    // 12. Partner notifications & devices
    `CREATE TABLE IF NOT EXISTS partner_notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      type VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      body TEXT NOT NULL,
      payload JSONB DEFAULT '{}'::jsonb,
      read_at TIMESTAMPTZ,
      event_key VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_partner_notifications_event UNIQUE (partner_id, event_key)
    );`,
    `CREATE INDEX IF NOT EXISTS idx_partner_notifications_partner_read ON partner_notifications(partner_id, read_at);`,

    `CREATE TABLE IF NOT EXISTS partner_device_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      token TEXT NOT NULL,
      platform VARCHAR(50) NOT NULL DEFAULT 'android',
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_partner_device_tokens UNIQUE (partner_id, token)
    );`,
    `CREATE INDEX IF NOT EXISTS idx_partner_device_tokens_partner ON partner_device_tokens(partner_id);`,

    // 13. Vehicle pricing & documents
    `ALTER TABLE vehicle_pricing ADD COLUMN IF NOT EXISTS price_per_hour NUMERIC(10,2);`,
    `ALTER TABLE vehicle_pricing ADD COLUMN IF NOT EXISTS price_per_4_hours NUMERIC(10,2);`,
    `ALTER TABLE vehicle_pricing ADD COLUMN IF NOT EXISTS price_per_day NUMERIC(10,2);`,
    `ALTER TABLE vehicle_pricing ADD COLUMN IF NOT EXISTS extra_km_charge NUMERIC(10,2) DEFAULT 0;`,
    `ALTER TABLE vehicle_pricing ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT 'INR';`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_pricing_vehicle_id ON vehicle_pricing(vehicle_id);`,

    `ALTER TABLE partner_documents ADD COLUMN IF NOT EXISTS storage_key TEXT;`,
    `ALTER TABLE partner_documents ADD COLUMN IF NOT EXISTS document_number VARCHAR(100);`,
    `ALTER TABLE partner_documents ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;`,
    `ALTER TABLE partner_documents ADD COLUMN IF NOT EXISTS rejection_reason TEXT;`,

    // 14. Commission, Damage, Earnings
    `CREATE TABLE IF NOT EXISTS commission_records (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      rate NUMERIC(5,2) NOT NULL DEFAULT 10.00,
      commission_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      partner_payout_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,
    `ALTER TABLE commission_records ADD COLUMN IF NOT EXISTS commission_type VARCHAR(50) DEFAULT 'PERCENTAGE';`,
    `ALTER TABLE commission_records ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,2) DEFAULT 10.00;`,
    `ALTER TABLE commission_records ADD COLUMN IF NOT EXISTS gross_booking_amount NUMERIC(12,2) DEFAULT 0;`,
    `ALTER TABLE commission_records ADD COLUMN IF NOT EXISTS partner_payable_amount NUMERIC(12,2) DEFAULT 0;`,

    `CREATE TABLE IF NOT EXISTS damage_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      photos JSONB DEFAULT '[]'::jsonb,
      estimated_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      approved_amount NUMERIC(12,2),
      status VARCHAR(50) NOT NULL DEFAULT 'REPORTED',
      reported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,
    `ALTER TABLE damage_reports ADD COLUMN IF NOT EXISTS reported_by VARCHAR(50) DEFAULT 'PARTNER';`,
    `ALTER TABLE damage_reports ADD COLUMN IF NOT EXISTS damage_type VARCHAR(100) DEFAULT 'SCRATCH_OR_DENT';`,

    `CREATE TABLE IF NOT EXISTS earnings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
      gross_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      commission_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      net_earnings NUMERIC(12,2) NOT NULL DEFAULT 0,
      status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
      period_start TIMESTAMPTZ,
      period_end TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,
    `ALTER TABLE earnings ADD COLUMN IF NOT EXISTS wallet_transaction_id UUID;`,
    `ALTER TABLE earnings ADD COLUMN IF NOT EXISTS partner_net_amount NUMERIC(12,2) DEFAULT 0;`,
    `ALTER TABLE earnings ADD COLUMN IF NOT EXISTS settlement_status VARCHAR(50) DEFAULT 'PENDING';`,
    `ALTER TABLE earnings ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;`,

    // 15. Vehicles & vehicle images
    `ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS brand VARCHAR(100);`,
    `ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS model VARCHAR(100);`,
    `ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS category VARCHAR(50);`,
    `ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS year INTEGER;`,
    `ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS fuel_type VARCHAR(50) DEFAULT 'PETROL';`,
    `ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS manual_status VARCHAR(50) DEFAULT 'ACTIVE';`,
    `ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS rental_status VARCHAR(50) DEFAULT 'AVAILABLE';`,
    `ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS rejection_reason TEXT;`,
    `ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS primary_image_url TEXT;`,
    `ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS variant VARCHAR(100);`,

    `ALTER TABLE vehicle_images ADD COLUMN IF NOT EXISTS storage_key TEXT;`,
    `ALTER TABLE vehicle_images ADD COLUMN IF NOT EXISTS is_cover BOOLEAN DEFAULT false;`,
    `ALTER TABLE vehicle_images ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;`,
    `ALTER TABLE vehicle_images ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;`,

    // 16. Bookings, verifications & pricing snapshots
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_status VARCHAR(50) DEFAULT 'CONFIRMED';`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255);`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(50);`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS expected_return_at TIMESTAMPTZ;`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_status VARCHAR(50) DEFAULT 'PAID';`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pickup_location TEXT;`,
    `UPDATE bookings SET booking_status = UPPER(status) WHERE booking_status IS NULL AND status IS NOT NULL;`,

    `CREATE TABLE IF NOT EXISTS booking_pricing_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id UUID NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
      base_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      extra_charges NUMERIC(12,2) NOT NULL DEFAULT 0,
      tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      platform_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
      security_deposit NUMERIC(12,2) NOT NULL DEFAULT 0,
      total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      currency VARCHAR(10) NOT NULL DEFAULT 'INR',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,
    `ALTER TABLE booking_pricing_snapshots ADD COLUMN IF NOT EXISTS rental_amount NUMERIC(12,2) DEFAULT 0;`,
    `ALTER TABLE booking_pricing_snapshots ADD COLUMN IF NOT EXISTS extra_km_charge NUMERIC(12,2) DEFAULT 0;`,
    `ALTER TABLE booking_pricing_snapshots ADD COLUMN IF NOT EXISTS late_fee NUMERIC(12,2) DEFAULT 0;`,
    `ALTER TABLE booking_pricing_snapshots ADD COLUMN IF NOT EXISTS taxes_amount NUMERIC(12,2) DEFAULT 0;`,
    `ALTER TABLE booking_pricing_snapshots ADD COLUMN IF NOT EXISTS total_customer_amount NUMERIC(12,2) DEFAULT 0;`,
    `ALTER TABLE booking_pricing_snapshots ADD COLUMN IF NOT EXISTS price_per_hour NUMERIC(10,2) DEFAULT 0;`,

    `CREATE TABLE IF NOT EXISTS booking_pickup_verifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id UUID NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
      otp_hash VARCHAR(255),
      verification_reference VARCHAR(100),
      is_verified BOOLEAN NOT NULL DEFAULT false,
      odometer_start NUMERIC(10,2),
      fuel_level_start VARCHAR(50),
      photos JSONB DEFAULT '[]'::jsonb,
      notes TEXT,
      verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS booking_return_verifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id UUID NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
      odometer_end NUMERIC(10,2),
      fuel_level_end VARCHAR(50),
      total_distance NUMERIC(10,2),
      photos JSONB DEFAULT '[]'::jsonb,
      damage_notes TEXT,
      notes TEXT,
      is_verified BOOLEAN NOT NULL DEFAULT false,
      verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,
    `ALTER TABLE booking_return_verifications ADD COLUMN IF NOT EXISTS late_fee NUMERIC(10,2) DEFAULT 0;`,
    `ALTER TABLE booking_return_verifications ADD COLUMN IF NOT EXISTS extra_km NUMERIC(10,2) DEFAULT 0;`,
    `ALTER TABLE booking_return_verifications ADD COLUMN IF NOT EXISTS extra_km_fee NUMERIC(10,2) DEFAULT 0;`,
    `ALTER TABLE booking_return_verifications ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ;`,
    `ALTER TABLE booking_return_verifications ADD COLUMN IF NOT EXISTS return_status VARCHAR(50) DEFAULT 'ON_TIME';`,
    `ALTER TABLE booking_return_verifications ADD COLUMN IF NOT EXISTS late_minutes INTEGER DEFAULT 0;`,
    `ALTER TABLE booking_pickup_verifications ADD COLUMN IF NOT EXISTS verified_by UUID;`,
    `ALTER TABLE booking_return_verifications ADD COLUMN IF NOT EXISTS verified_by UUID;`,

    `CREATE TABLE IF NOT EXISTS vehicle_availability_blocks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
      start_time TIMESTAMPTZ NOT NULL,
      end_time TIMESTAMPTZ NOT NULL,
      reason VARCHAR(100) NOT NULL DEFAULT 'Maintenance',
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,
    `ALTER TABLE vehicle_availability_blocks ADD COLUMN IF NOT EXISTS created_by VARCHAR(50) DEFAULT 'PARTNER';`,
    `CREATE INDEX IF NOT EXISTS idx_vab_vehicle_dates ON vehicle_availability_blocks(vehicle_id, start_time, end_time);`
  ];

  for (let i = 0; i < ddlStatements.length; i++) {
    const stmt = ddlStatements[i];
    try {
      await pool.query(stmt);
      console.log(`[${i + 1}/${ddlStatements.length}] Success: ${stmt.trim().slice(0, 50)}...`);
    } catch (err) {
      console.error(`[${i + 1}/${ddlStatements.length}] FAILED: ${stmt.trim().slice(0, 60)}...`);
      console.error(err.message);
    }
  }

  console.log('All alignment statements processed successfully.');
  process.exit(0);
}

applyAlignment().catch(err => {
  console.error('Fatal error in alignment runner:', err);
  process.exit(1);
});
