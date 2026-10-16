-- ==============================================================================
-- GONGO RATINGS SYSTEM FOUNDATION & SUPABASE RLS MIGRATION
-- Scope: Reusable ratings table, constraints, indexes, triggers, and Row Level Security
-- ==============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES public.bookings(id) ON DELETE RESTRICT,
  customer_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  partner_id UUID NOT NULL REFERENCES public.partners(id) ON DELETE RESTRICT,
  vehicle_id UUID REFERENCES public.vehicles(id) ON DELETE SET NULL,
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

CREATE INDEX IF NOT EXISTS idx_ratings_partner_target_status
  ON public.ratings (partner_id, target_type, status);

CREATE INDEX IF NOT EXISTS idx_ratings_vehicle_target_status
  ON public.ratings (vehicle_id, target_type, status);

CREATE INDEX IF NOT EXISTS idx_ratings_booking_id
  ON public.ratings (booking_id);

CREATE INDEX IF NOT EXISTS idx_ratings_customer_id
  ON public.ratings (customer_id);

CREATE INDEX IF NOT EXISTS idx_ratings_created_at
  ON public.ratings (created_at DESC);

ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS rating_avg NUMERIC(3,2) DEFAULT NULL;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS rating_count INTEGER DEFAULT 0;

-- Trigger to maintain updated_at on ratings
DROP TRIGGER IF EXISTS trg_ratings_updated_at ON public.ratings;
CREATE TRIGGER trg_ratings_updated_at
BEFORE UPDATE ON public.ratings
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Trigger Function to maintain vehicles.rating_avg & rating_count automatically
CREATE OR REPLACE FUNCTION public.sync_vehicle_rating_aggregates()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_id UUID;
BEGIN
  v_id := COALESCE(NEW.vehicle_id, OLD.vehicle_id);

  IF v_id IS NOT NULL THEN
    UPDATE public.vehicles v
    SET
      rating_avg = (
        SELECT ROUND(AVG(r.rating_score)::numeric, 1)
        FROM public.ratings r
        JOIN public.bookings b ON b.id = r.booking_id
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
        FROM public.ratings r
        JOIN public.bookings b ON b.id = r.booking_id
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
    UPDATE public.vehicles v
    SET
      rating_avg = (
        SELECT ROUND(AVG(r.rating_score)::numeric, 1)
        FROM public.ratings r
        JOIN public.bookings b ON b.id = r.booking_id
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
        FROM public.ratings r
        JOIN public.bookings b ON b.id = r.booking_id
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

DROP TRIGGER IF EXISTS trg_ratings_sync_vehicle_aggregates ON public.ratings;
CREATE TRIGGER trg_ratings_sync_vehicle_aggregates
AFTER INSERT OR UPDATE OR DELETE ON public.ratings
FOR EACH ROW
EXECUTE FUNCTION public.sync_vehicle_rating_aggregates();

-- Security Definer Helper Functions for RLS Resolution
CREATE OR REPLACE FUNCTION public.get_auth_partner_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sub TEXT;
  v_partner_id UUID;
BEGIN
  v_sub := nullif(current_setting('request.jwt.claim.sub', true), '');
  IF v_sub IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT p.id INTO v_partner_id
  FROM public.partners p
  JOIN public.users u ON u.id = p.user_id
  WHERE u.id::text = v_sub OR u.auth_id = v_sub
  LIMIT 1;

  RETURN v_partner_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_auth_user_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sub TEXT;
  v_user_id UUID;
BEGIN
  v_sub := nullif(current_setting('request.jwt.claim.sub', true), '');
  IF v_sub IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT u.id INTO v_user_id
  FROM public.users u
  WHERE u.id::text = v_sub OR u.auth_id = v_sub
  LIMIT 1;

  RETURN v_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_customer_rating_submission(
  p_booking_id UUID,
  p_customer_id UUID,
  p_partner_id UUID,
  p_vehicle_id UUID,
  p_target_type VARCHAR
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.bookings b
    WHERE b.id = p_booking_id
      AND b.customer_id = p_customer_id
      AND b.partner_id = p_partner_id
      AND (
        p_target_type != 'VEHICLE'
        OR b.vehicle_id = p_vehicle_id
      )
      AND (
        b.booking_status IN ('COMPLETED', 'CONFIRMED')
        OR COALESCE(b.status, '') IN ('completed', 'returned')
      )
  );
$$;

GRANT EXECUTE ON FUNCTION public.get_auth_partner_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_auth_user_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.validate_customer_rating_submission TO authenticated;

-- Enable Row Level Security (RLS) and configure permissions
ALTER TABLE public.ratings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.ratings TO authenticated;
REVOKE UPDATE, DELETE ON public.ratings FROM authenticated;
REVOKE ALL ON public.ratings FROM anon;

-- Partners can read only approved ratings linked to their partner profile
DROP POLICY IF EXISTS partner_view_own_ratings ON public.ratings;
CREATE POLICY partner_view_own_ratings ON public.ratings
  FOR SELECT
  TO authenticated
  USING (
    partner_id = public.get_auth_partner_id()
    AND status = 'APPROVED'
  );

-- Customers can read their own submitted ratings
DROP POLICY IF EXISTS customer_view_own_ratings ON public.ratings;
CREATE POLICY customer_view_own_ratings ON public.ratings
  FOR SELECT
  TO authenticated
  USING (
    customer_id = public.get_auth_user_id()
  );

-- Customers can submit ratings only for their own eligible completed bookings without spoofing
DROP POLICY IF EXISTS customer_submit_rating ON public.ratings;
CREATE POLICY customer_submit_rating ON public.ratings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    customer_id = public.get_auth_user_id()
    AND public.validate_customer_rating_submission(booking_id, customer_id, partner_id, vehicle_id, target_type)
    AND status IN ('APPROVED', 'PENDING')
  );

COMMIT;
