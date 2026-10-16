-- ==============================================================================
-- GONGO PRODUCTION SUPABASE SECURITY HARDENING MIGRATION
-- Executed on: 2026-10-07
-- Scope: 19 RLS-disabled public tables, 3 security-definer public views
-- Target: Zero PostgREST exposure for untrusted roles (anon, authenticated)
-- Preserves: 100% backend Express and OutboxWorker functionality via trusted pool
-- ==============================================================================

BEGIN;

-- 1. Security-definer views remediation: set security_invoker = true and revoke anon, authenticated
ALTER VIEW public."support_ticket_messages" SET (security_invoker = true);
REVOKE ALL ON TABLE public."support_ticket_messages" FROM anon, authenticated;

ALTER VIEW public."wallets" SET (security_invoker = true);
REVOKE ALL ON TABLE public."wallets" FROM anon, authenticated;

ALTER VIEW public."payouts" SET (security_invoker = true);
REVOKE ALL ON TABLE public."payouts" FROM anon, authenticated;

-- 2. Enable RLS and revoke anon, authenticated on 19 backend-only tables
ALTER TABLE public."storage_uploads" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."storage_uploads" FROM anon, authenticated;

ALTER TABLE public."payment_events" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."payment_events" FROM anon, authenticated;

ALTER TABLE public."earnings" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."earnings" FROM anon, authenticated;

ALTER TABLE public."schema_migrations" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."schema_migrations" FROM anon, authenticated;

ALTER TABLE public."booking_pickup_verifications" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."booking_pickup_verifications" FROM anon, authenticated;

ALTER TABLE public."vehicle_availability_blocks" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."vehicle_availability_blocks" FROM anon, authenticated;

ALTER TABLE public."partner_notifications" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."partner_notifications" FROM anon, authenticated;

ALTER TABLE public."partner_device_tokens" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."partner_device_tokens" FROM anon, authenticated;

ALTER TABLE public."booking_pricing_snapshots" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."booking_pricing_snapshots" FROM anon, authenticated;

ALTER TABLE public."commission_records" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."commission_records" FROM anon, authenticated;

ALTER TABLE public."damage_reports" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."damage_reports" FROM anon, authenticated;

ALTER TABLE public."admin_settings" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."admin_settings" FROM anon, authenticated;

ALTER TABLE public."admin_permissions" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."admin_permissions" FROM anon, authenticated;

ALTER TABLE public."admin_sessions" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."admin_sessions" FROM anon, authenticated;

ALTER TABLE public."outbox_events" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."outbox_events" FROM anon, authenticated;

ALTER TABLE public."vehicle_pricing_history" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."vehicle_pricing_history" FROM anon, authenticated;

ALTER TABLE public."booking_return_verifications" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."booking_return_verifications" FROM anon, authenticated;

ALTER TABLE public."pgmigrations" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."pgmigrations" FROM anon, authenticated;

ALTER TABLE public."idempotency_keys" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public."idempotency_keys" FROM anon, authenticated;

COMMIT;
