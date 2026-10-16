-- ==============================================================================
-- GONGO MIGRATION: 20261015_remediate_security_advisor_and_outbox_optimization.sql
-- Description:
--   1. Outbox Claim & Stale Recovery Slow Query Index Optimization
--   2. RLS Remediation for cancellation_refund_rules, franchise_applications, partner_consents
--   3. Audit & Drop Confirmed Duplicate/Redundant Indexes
--   4. Security Definer Functions Hardening (Pinned search_path, explicit schemas, least privilege)
--   5. Mutable search_path Remediation for updated_at & reference generator functions
--   6. Ratings Table Policies Simplification & Hardening
--
-- Safety & Concurrency Note:
--   - Wrapped in a transaction block (BEGIN / COMMIT).
--   - In ultra-high-concurrency production deployments where holding ACCESS EXCLUSIVE
--     locks on outbox_events during index creation is undesirable, step 1 can be executed
--     separately as: CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outbox_events_admin_claim_opt ...
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- 1. OUTBOX QUERY OPTIMIZATION (Composite Partial Index)
-- ==============================================================================
-- The claimEvents query predicates:
--   WHERE ((status = 'PENDING' AND next_retry_at <= CURRENT_TIMESTAMP)
--      OR (status = 'FAILED' AND retry_count < max_retries AND next_retry_at <= CURRENT_TIMESTAMP))
--     AND (aggregate_type/event_type matches ADMIN ownership)
--   ORDER BY created_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED
-- 
-- The existing partial index idx_outbox_events_claim (status, next_retry_at, created_at)
-- forces the planner through index filtering and explicit in-memory/disk sort operations
-- on created_at when evaluating empty queue states.
-- We add an optimized index matching the exact query claim order and status predicate.

CREATE INDEX IF NOT EXISTS idx_outbox_events_admin_claim_opt
ON public.outbox_events (next_retry_at ASC, created_at ASC)
WHERE status IN ('PENDING', 'FAILED');

-- ==============================================================================
-- 2. ROW LEVEL SECURITY (RLS) REMEDIATION
-- ==============================================================================
-- Supabase Advisor reported RLS disabled for:
--   - public.cancellation_refund_rules
--   - public.franchise_applications
--   - public.partner_consents
--
-- Access Control Architecture:
-- 1) cancellation_refund_rules: System configuration rules managed exclusively by
--    the unified Admin backend (cancellation-rules.repository.js).
--    Customer cancellation service reads via trusted backend pool client.
--    No direct client/PostgREST mutation allowed.
-- 2) franchise_applications: Prospective partner applications created via backend API
--    (franchise.service.js) and reviewed by Super Admins.
--    Must be sealed from anonymous/untrusted PostgREST direct inspection or harvesting.
-- 3) partner_consents: Immutable compliance lease & terms records. Managed via
--    Partner backend (consent.repository.js).
--    Direct PostgREST access revoked to prevent tampering or BOLA leaks.

-- Enable RLS
ALTER TABLE public.cancellation_refund_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.franchise_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_consents ENABLE ROW LEVEL SECURITY;

-- Revoke all direct privileges from untrusted PostgREST roles (anon, authenticated)
REVOKE ALL ON TABLE public.cancellation_refund_rules FROM anon, authenticated;
REVOKE ALL ON TABLE public.franchise_applications FROM anon, authenticated;
REVOKE ALL ON TABLE public.partner_consents FROM anon, authenticated;

-- Ensure trusted backend roles maintain full operational privileges
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON TABLE public.cancellation_refund_rules TO service_role;
    GRANT ALL ON TABLE public.franchise_applications TO service_role;
    GRANT ALL ON TABLE public.partner_consents TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    GRANT ALL ON TABLE public.cancellation_refund_rules TO postgres;
    GRANT ALL ON TABLE public.franchise_applications TO postgres;
    GRANT ALL ON TABLE public.partner_consents TO postgres;
  END IF;
END $$;

-- ==============================================================================
-- 3. AUDIT & DROP CONFIRMED DUPLICATE INDEXES
-- ==============================================================================
-- Comparison & Rationale:
-- 1) public.admin_sessions:
--    - Table has UNIQUE constraint on session_token -> creates admin_sessions_session_token_key.
--    - Migration 041 also executed: CREATE UNIQUE INDEX idx_admin_sessions_token ON admin_sessions (session_token).
--    - CONFIRMED 100% IDENTICAL DUPLICATE. Drop idx_admin_sessions_token, retain unique constraint index.
DROP INDEX IF EXISTS public.idx_admin_sessions_token;

-- 2) public.admin_settings:
--    - Table has UNIQUE constraint on key -> creates admin_settings_key_key.
--    - Migration 040 also executed: CREATE UNIQUE INDEX idx_admin_settings_key ON admin_settings (key).
--    - CONFIRMED 100% IDENTICAL DUPLICATE. Drop idx_admin_settings_key, retain unique constraint index.
DROP INDEX IF EXISTS public.idx_admin_settings_key;

-- 3) public.storage_uploads:
--    - Migration 031 creates: idx_storage_uploads_partner_id ON (partner_id).
--    - apply_supabase_alignment / SUPABASE_PARTNER_DATABASE_COMPATIBILITY creates:
--      idx_storage_uploads_partner ON (partner_id, status).
--    - Left-prefix match: (partner_id, status) fully covers single-column lookups on partner_id.
--    - Ensure composite index exists in all environments before dropping redundant single-column index.
CREATE INDEX IF NOT EXISTS idx_storage_uploads_partner ON public.storage_uploads (partner_id, status);
DROP INDEX IF EXISTS public.idx_storage_uploads_partner_id;

-- 4) public.support_tickets:
--    - Table has UNIQUE constraint on ticket_number -> creates uq_support_tickets_number / support_tickets_ticket_number_key.
--    - Customer migration 1727700000000 also defined unique ticket_number.
--    - If duplicate index idx_support_tickets_ticket_number exists alongside the unique constraint, drop it.
DROP INDEX IF EXISTS public.idx_support_tickets_ticket_number;

-- 5) public.vehicle_pricing_history:
--    - Migration 012 created:
--      idx_vehicle_pricing_history_vehicle_id ON (vehicle_id);
--      idx_vehicle_pricing_history_valid_range ON (vehicle_id, valid_from, valid_to);
--    - The composite index (vehicle_id, valid_from, valid_to) has vehicle_id as its leading left-prefix.
--    - PostgreSQL btree traversal uses the composite index for queries on vehicle_id alone.
--    - CONFIRMED REDUNDANT LEADING-PREFIX INDEX. Drop idx_vehicle_pricing_history_vehicle_id.
DROP INDEX IF EXISTS public.idx_vehicle_pricing_history_vehicle_id;

-- ==============================================================================
-- 4. SECURE SECURITY DEFINER FUNCTIONS
-- ==============================================================================
-- Pin search_path = public, pg_temp; schema-qualify tables; restrict grants.

-- 4a. get_auth_partner_id()
CREATE OR REPLACE FUNCTION public.get_auth_partner_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
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

-- Revoke broad EXECUTE, allow authenticated and service_role for RLS policy evaluation
REVOKE ALL ON FUNCTION public.get_auth_partner_id() FROM PUBLIC, anon;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.get_auth_partner_id() TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.get_auth_partner_id() TO service_role;
  END IF;
END $$;

-- 4b. get_auth_user_id()
CREATE OR REPLACE FUNCTION public.get_auth_user_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
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

REVOKE ALL ON FUNCTION public.get_auth_user_id() FROM PUBLIC, anon;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.get_auth_user_id() TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.get_auth_user_id() TO service_role;
  END IF;
END $$;

-- 4c. validate_customer_rating_submission
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
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.bookings b
    WHERE b.id = p_booking_id
      AND b.customer_id = p_customer_id
      AND (public.get_auth_user_id() IS NULL OR p_customer_id = public.get_auth_user_id())
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

REVOKE ALL ON FUNCTION public.validate_customer_rating_submission(UUID, UUID, UUID, UUID, VARCHAR) FROM PUBLIC, anon;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.validate_customer_rating_submission(UUID, UUID, UUID, UUID, VARCHAR) TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.validate_customer_rating_submission(UUID, UUID, UUID, UUID, VARCHAR) TO service_role;
  END IF;
END $$;

-- 4d. sync_vehicle_rating_aggregates
-- Trigger function invoked upon rating insert/update/delete.
CREATE OR REPLACE FUNCTION public.sync_vehicle_rating_aggregates()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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

REVOKE ALL ON FUNCTION public.sync_vehicle_rating_aggregates() FROM PUBLIC, anon;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.sync_vehicle_rating_aggregates() TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.sync_vehicle_rating_aggregates() TO service_role;
  END IF;
END $$;

-- ==============================================================================
-- 5. MUTABLE SEARCH PATH REMEDIATION FOR UTILITY & TRIGGER FUNCTIONS
-- ==============================================================================

-- 5a. generate_gongo_reference
CREATE OR REPLACE FUNCTION public.generate_gongo_reference(prefix text, len integer DEFAULT 6)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  charset text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  result text := prefix || '-';
  i integer;
BEGIN
  FOR i IN 1..len LOOP
    result := result || substr(charset, floor(random() * length(charset) + 1)::integer, 1);
  END LOOP;
  RETURN result;
END;
$$;

-- 5b. update_updated_at_column
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

-- 5c. set_updated_at (used by Customer triggers)
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

-- ==============================================================================
-- 6. RATINGS POLICIES CONSOLIDATION & HARDENING
-- ==============================================================================
-- Standardize cleanly on the hardened, secure helper functions:
DROP POLICY IF EXISTS partner_view_own_ratings ON public.ratings;
CREATE POLICY partner_view_own_ratings ON public.ratings
  FOR SELECT
  TO authenticated
  USING (
    partner_id = public.get_auth_partner_id()
    AND status = 'APPROVED'
  );

DROP POLICY IF EXISTS customer_view_own_ratings ON public.ratings;
CREATE POLICY customer_view_own_ratings ON public.ratings
  FOR SELECT
  TO authenticated
  USING (
    customer_id = public.get_auth_user_id()
  );

DROP POLICY IF EXISTS customer_submit_rating ON public.ratings;
CREATE POLICY customer_submit_rating ON public.ratings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    customer_id = public.get_auth_user_id()
    AND public.validate_customer_rating_submission(booking_id, customer_id, partner_id, vehicle_id, target_type)
    AND status IN ('APPROVED', 'PENDING')
  );

-- Ensure untrusted roles cannot update or delete ratings
REVOKE UPDATE, DELETE ON public.ratings FROM authenticated, anon;

COMMIT;
