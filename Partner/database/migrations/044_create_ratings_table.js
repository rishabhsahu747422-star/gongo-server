'use strict';

exports.shorthands = undefined;

/**
 * Migration 044: Create Ratings Table & Rating Foundation
 *
 * Establishes the reusable ratings schema for GONGO:
 * - Supports partner ratings and vehicle-specific ratings from completed bookings
 * - Prevents duplicate ratings per booking and target_type
 * - Incorporates moderation status, score constraint (1-5), review comments
 * - Ensures partner/vehicle aggregates are cleanly separated without double-counting
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS ratings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
      customer_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
      vehicle_id UUID REFERENCES vehicles(id) ON DELETE SET NULL,
      target_type VARCHAR(20) NOT NULL DEFAULT 'PARTNER',
      rating_score INTEGER NOT NULL,
      review_comment TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'APPROVED',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_ratings_score CHECK (rating_score >= 1 AND rating_score <= 5),
      CONSTRAINT chk_ratings_target_type CHECK (target_type IN ('PARTNER', 'VEHICLE')),
      CONSTRAINT chk_ratings_status CHECK (status IN ('APPROVED', 'PENDING', 'FLAGGED', 'HIDDEN')),
      CONSTRAINT chk_ratings_vehicle_required CHECK (target_type != 'VEHICLE' OR vehicle_id IS NOT NULL),
      CONSTRAINT uq_ratings_booking_target UNIQUE (booking_id, target_type)
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_ratings_partner_target_status
    ON ratings (partner_id, target_type, status);

    CREATE INDEX IF NOT EXISTS idx_ratings_vehicle_target_status
    ON ratings (vehicle_id, target_type, status);

    CREATE INDEX IF NOT EXISTS idx_ratings_booking_id
    ON ratings (booking_id);

    CREATE INDEX IF NOT EXISTS idx_ratings_customer_id
    ON ratings (customer_id);

    CREATE INDEX IF NOT EXISTS idx_ratings_created_at
    ON ratings (created_at DESC);
  `);

  await pgm.sql(`
    ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS rating_avg NUMERIC(3,2) DEFAULT NULL;
    ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS rating_count INTEGER DEFAULT 0;
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_ratings_updated_at ON ratings;
    CREATE TRIGGER trg_ratings_updated_at
    BEFORE UPDATE ON ratings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);

  await pgm.sql(`
    CREATE OR REPLACE FUNCTION sync_vehicle_rating_aggregates()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    AS $$
    DECLARE
      v_id UUID;
    BEGIN
      v_id := COALESCE(NEW.vehicle_id, OLD.vehicle_id);

      IF v_id IS NOT NULL THEN
        UPDATE vehicles v
        SET
          rating_avg = (
            SELECT ROUND(AVG(r.rating_score)::numeric, 1)
            FROM ratings r
            JOIN bookings b ON b.id = r.booking_id
            WHERE r.vehicle_id = v_id
              AND r.target_type = 'VEHICLE'
              AND r.status = 'APPROVED'
              AND (
                b.booking_status IN ('COMPLETED', 'CONFIRMED')
                OR COALESCE(b.status, '') IN ('completed', 'returned')
              )
          ),
          rating_count = COALESCE((
            SELECT COUNT(*)
            FROM ratings r
            JOIN bookings b ON b.id = r.booking_id
            WHERE r.vehicle_id = v_id
              AND r.target_type = 'VEHICLE'
              AND r.status = 'APPROVED'
              AND (
                b.booking_status IN ('COMPLETED', 'CONFIRMED')
                OR COALESCE(b.status, '') IN ('completed', 'returned')
              )
          ), 0)::int
        WHERE v.id = v_id;
      END IF;

      IF TG_OP = 'UPDATE' AND OLD.vehicle_id IS DISTINCT FROM NEW.vehicle_id AND OLD.vehicle_id IS NOT NULL THEN
        UPDATE vehicles v
        SET
          rating_avg = (
            SELECT ROUND(AVG(r.rating_score)::numeric, 1)
            FROM ratings r
            JOIN bookings b ON b.id = r.booking_id
            WHERE r.vehicle_id = OLD.vehicle_id
              AND r.target_type = 'VEHICLE'
              AND r.status = 'APPROVED'
              AND (
                b.booking_status IN ('COMPLETED', 'CONFIRMED')
                OR COALESCE(b.status, '') IN ('completed', 'returned')
              )
          ),
          rating_count = COALESCE((
            SELECT COUNT(*)
            FROM ratings r
            JOIN bookings b ON b.id = r.booking_id
            WHERE r.vehicle_id = OLD.vehicle_id
              AND r.target_type = 'VEHICLE'
              AND r.status = 'APPROVED'
              AND (
                b.booking_status IN ('COMPLETED', 'CONFIRMED')
                OR COALESCE(b.status, '') IN ('completed', 'returned')
              )
          ), 0)::int
        WHERE v.id = OLD.vehicle_id;
      END IF;

      RETURN COALESCE(NEW, OLD);
    END;
    $$;

    DROP TRIGGER IF EXISTS trg_ratings_sync_vehicle_aggregates ON ratings;
    CREATE TRIGGER trg_ratings_sync_vehicle_aggregates
    AFTER INSERT OR UPDATE OR DELETE ON ratings
    FOR EACH ROW
    EXECUTE FUNCTION sync_vehicle_rating_aggregates();
  `);

  await pgm.sql(`
    ALTER TABLE ratings ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS partner_view_own_ratings ON ratings;
    CREATE POLICY partner_view_own_ratings ON ratings
      FOR SELECT
      TO authenticated
      USING (
        partner_id IN (
          SELECT p.id
          FROM partners p
          JOIN users u ON u.id = p.user_id
          WHERE u.id::text = auth.uid()::text OR u.auth_id = auth.uid()::text
        )
        AND status = 'APPROVED'
      );

    DROP POLICY IF EXISTS customer_view_own_ratings ON ratings;
    CREATE POLICY customer_view_own_ratings ON ratings
      FOR SELECT
      TO authenticated
      USING (
        customer_id IN (
          SELECT u.id
          FROM users u
          WHERE u.id::text = auth.uid()::text OR u.auth_id = auth.uid()::text
        )
      );

    DROP POLICY IF EXISTS customer_submit_rating ON ratings;
    CREATE POLICY customer_submit_rating ON ratings
      FOR INSERT
      TO authenticated
      WITH CHECK (
        customer_id IN (
          SELECT u.id
          FROM users u
          WHERE u.id::text = auth.uid()::text OR u.auth_id = auth.uid()::text
        )
        AND EXISTS (
          SELECT 1
          FROM bookings b
          WHERE b.id = booking_id
            AND b.customer_id = customer_id
            AND b.partner_id = partner_id
            AND (
              target_type != 'VEHICLE'
              OR b.vehicle_id = vehicle_id
            )
            AND (
              b.booking_status IN ('COMPLETED', 'CONFIRMED')
              OR COALESCE(b.status, '') IN ('completed', 'returned')
            )
        )
        AND status IN ('APPROVED', 'PENDING')
      );
  `);
};

exports.down = async (pgm) => {
  await pgm.sql(`
    DROP POLICY IF EXISTS customer_submit_rating ON ratings;
    DROP POLICY IF EXISTS customer_view_own_ratings ON ratings;
    DROP POLICY IF EXISTS partner_view_own_ratings ON ratings;
    DROP TRIGGER IF EXISTS trg_ratings_sync_vehicle_aggregates ON ratings;
    DROP FUNCTION IF EXISTS sync_vehicle_rating_aggregates();
    DROP TRIGGER IF EXISTS trg_ratings_updated_at ON ratings;
    DROP TABLE IF EXISTS ratings CASCADE;
  `);
};
