-- ==============================================================================
-- GONGO ROLLBACK MIGRATION: 20261015_rollback_security_advisor_and_outbox_optimization.sql
-- Description:
--   Rollback for 20261015_remediate_security_advisor_and_outbox_optimization.sql
-- ==============================================================================

BEGIN;

-- 1. Rollback outbox optimized index
DROP INDEX IF EXISTS public.idx_outbox_events_admin_claim_opt;

-- 2. Rollback RLS on the 3 tables (disables RLS to restore pre-migration baseline)
ALTER TABLE public.cancellation_refund_rules DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.franchise_applications DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_consents DISABLE ROW LEVEL SECURITY;

-- 3. Re-create dropped duplicate/redundant indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_sessions_token ON public.admin_sessions (session_token);
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_settings_key ON public.admin_settings (key);
CREATE INDEX IF NOT EXISTS idx_storage_uploads_partner_id ON public.storage_uploads (partner_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_ticket_number ON public.support_tickets (ticket_number);
CREATE INDEX IF NOT EXISTS idx_vehicle_pricing_history_vehicle_id ON public.vehicle_pricing_history (vehicle_id);

-- 4. Rollback utility functions to pre-migration signatures
CREATE OR REPLACE FUNCTION public.generate_gongo_reference(prefix text, len integer DEFAULT 6)
RETURNS text
LANGUAGE plpgsql
VOLATILE
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

-- 5. Re-grant functions to authenticated as per pre-hardening state (20261010)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT, INSERT ON public.ratings TO authenticated;
    GRANT EXECUTE ON FUNCTION public.get_auth_partner_id() TO authenticated;
    GRANT EXECUTE ON FUNCTION public.get_auth_user_id() TO authenticated;
    GRANT EXECUTE ON FUNCTION public.validate_customer_rating_submission(UUID, UUID, UUID, UUID, VARCHAR) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.sync_vehicle_rating_aggregates() TO authenticated;
  END IF;
END $$;

COMMIT;
