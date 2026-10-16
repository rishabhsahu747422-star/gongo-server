-- ==============================================================================
-- GONGO PRODUCTION SUPABASE SECURITY HARDENING EXACT ROLLBACK SCRIPT
-- Generated strictly from: zmdfiles/security_hardening_before_snapshot.json
-- Restores pre-hardening state exactly without using any wildcard statements.
-- ==============================================================================

BEGIN;

-- 1. Restore views security_invoker = false and grants
ALTER VIEW public."support_ticket_messages" SET (security_invoker = false);
GRANT ALL ON TABLE public."support_ticket_messages" TO anon, authenticated;

ALTER VIEW public."wallets" SET (security_invoker = false);
GRANT ALL ON TABLE public."wallets" TO anon, authenticated;

ALTER VIEW public."payouts" SET (security_invoker = false);
GRANT ALL ON TABLE public."payouts" TO anon, authenticated;

-- 2. Disable RLS and restore grants on the 19 tables
ALTER TABLE public."storage_uploads" DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public."storage_uploads" TO anon, authenticated;

ALTER TABLE public."payment_events" DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public."payment_events" TO anon, authenticated;

ALTER TABLE public."earnings" DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public."earnings" TO anon, authenticated;

ALTER TABLE public."schema_migrations" DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public."schema_migrations" TO anon, authenticated;

ALTER TABLE public."booking_pickup_verifications" DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public."booking_pickup_verifications" TO anon, authenticated;

ALTER TABLE public."vehicle_availability_blocks" DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public."vehicle_availability_blocks" TO anon, authenticated;

ALTER TABLE public."partner_notifications" DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public."partner_notifications" TO anon, authenticated;

ALTER TABLE public."partner_device_tokens" DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public."partner_device_tokens" TO anon, authenticated;

ALTER TABLE public."booking_pricing_snapshots" DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public."booking_pricing_snapshots" TO anon, authenticated;

ALTER TABLE public."commission_records" DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public."commission_records" TO anon, authenticated;

ALTER TABLE public."damage_reports" DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public."damage_reports" TO anon, authenticated;

ALTER TABLE public."admin_settings" DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public."admin_settings" TO anon, authenticated;

ALTER TABLE public."admin_permissions" DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public."admin_permissions" TO anon, authenticated;

ALTER TABLE public."admin_sessions" DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public."admin_sessions" TO anon, authenticated;

ALTER TABLE public."outbox_events" DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public."outbox_events" TO anon, authenticated;

ALTER TABLE public."vehicle_pricing_history" DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public."vehicle_pricing_history" TO anon, authenticated;

ALTER TABLE public."booking_return_verifications" DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public."booking_return_verifications" TO anon, authenticated;

ALTER TABLE public."pgmigrations" DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public."pgmigrations" TO anon, authenticated;

ALTER TABLE public."idempotency_keys" DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public."idempotency_keys" TO anon, authenticated;

COMMIT;
