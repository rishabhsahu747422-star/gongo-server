import json
import os
import urllib.parse
import pg8000.native

env_file = r"C:\Users\risha\.gemini\antigravity\scratch\gongo-partner-backend\.env"
config = {}
with open(env_file, "r", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            parts = line.split("=", 1)
            config[parts[0].strip()] = parts[1].strip()

db_url = config.get("DATABASE_URL")
parsed = urllib.parse.urlparse(db_url)

con = pg8000.native.Connection(
    user=parsed.username,
    password=parsed.password,
    host=parsed.hostname,
    port=parsed.port or 5432,
    database=parsed.path.lstrip('/'),
    ssl_context=True,
    timeout=60
)

print("Starting precise transactional dry-run...")
con.run("SET default_transaction_read_only = off;")
con.run("BEGIN;")

queries = [
    ("customer_identity_links", "DELETE FROM public.customer_identity_links WHERE customer_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer');"),
    ("identity_verification_audits", "DELETE FROM public.identity_verification_audits WHERE customer_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer');"),
    ("customer_identity_verifications", "DELETE FROM public.customer_identity_verifications WHERE customer_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer');"),
    ("customer_documents", "DELETE FROM public.customer_documents WHERE customer_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer');"),
    ("customer_profiles", "DELETE FROM public.customer_profiles WHERE user_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer');"),
    ("notifications", "DELETE FROM public.notifications WHERE customer_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer') OR (user_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer') AND customer_id IS NULL);"),
    ("idempotency_keys", "DELETE FROM public.idempotency_keys WHERE user_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer');"),
    
    # 2. Support Ticket Data
    ("support_messages (customer ticket)", """
        DELETE FROM public.support_messages 
        WHERE ticket_id::text IN (
          SELECT id::text FROM public.support_tickets 
          WHERE customer_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer')
             OR (user_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer') AND partner_id IS NULL)
        );
    """),
    ("ticket_status_history (customer ticket)", """
        DELETE FROM public.ticket_status_history 
        WHERE ticket_id::text IN (
          SELECT id::text FROM public.support_tickets 
          WHERE customer_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer')
             OR (user_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer') AND partner_id IS NULL)
        );
    """),
    ("support_tickets (customer)", """
        DELETE FROM public.support_tickets 
        WHERE customer_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer')
           OR (user_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer') AND partner_id IS NULL);
    """),

    # 3. Booking Children & Verifications (ALL 36 bookings)
    ("booking_pickup_verifications", "DELETE FROM public.booking_pickup_verifications WHERE booking_id::text IN (SELECT id::text FROM public.bookings);"),
    ("booking_price_breakdown", "DELETE FROM public.booking_price_breakdown WHERE booking_id::text IN (SELECT id::text FROM public.bookings);"),
    ("booking_status_history", "DELETE FROM public.booking_status_history WHERE booking_id::text IN (SELECT id::text FROM public.bookings);"),
    ("booking_cancellations", "DELETE FROM public.booking_cancellations WHERE booking_id::text IN (SELECT id::text FROM public.bookings);"),

    # 4. Financial Children of Bookings & Payments
    ("payment_attempts", "DELETE FROM public.payment_attempts WHERE payment_id::text IN (SELECT id::text FROM public.payments);"),
    ("payments", "DELETE FROM public.payments;"),
    ("commission_records (linked to bookings)", "DELETE FROM public.commission_records WHERE booking_id::text IN (SELECT id::text FROM public.bookings);"),
    ("earnings (linked to bookings)", "DELETE FROM public.earnings WHERE booking_id::text IN (SELECT id::text FROM public.bookings);"),

    # 5. Core Bookings
    ("bookings (ALL 36 bookings)", "DELETE FROM public.bookings;"),

    # 6. Disassociate Customer References in Preserved Admin / Audit Tables
    ("admin_actions (disassociate customer actor/admin references)", """
        UPDATE public.admin_actions 
        SET actor_id = NULL, admin_id = NULL 
        WHERE actor_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer')
           OR admin_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer');
    """),
    ("users.created_by (disassociate customer creator reference for staff accounts)", """
        UPDATE public.users 
        SET created_by = NULL 
        WHERE created_by::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer');
    """),

    # 7. Customer Users
    ("users (customer accounts only)", "DELETE FROM public.users WHERE LOWER(role) = 'customer';")
]

for label, sql in queries:
    con.run(sql)
    print(f"  [DRY-RUN DELETED] {label}")

# Validate Post-Cleanup State inside transaction
print("\n--- Validating Post-Cleanup State Inside Transaction ---")
v_admins = con.run("SELECT count(*) FROM public.users WHERE LOWER(role) IN ('admin', 'super_admin', 'support_executive');")[0][0]
v_partners = con.run("SELECT count(*) FROM public.users WHERE LOWER(role) = 'partner';")[0][0]
v_customers = con.run("SELECT count(*) FROM public.users WHERE LOWER(role) = 'customer';")[0][0]
v_bookings = con.run("SELECT count(*) FROM public.bookings;")[0][0]
v_payments = con.run("SELECT count(*) FROM public.payments;")[0][0]
v_wallets = con.run("SELECT count(*) FROM public.partner_wallets;")[0][0]
v_wallet_tx = con.run("SELECT count(*) FROM public.wallet_transactions;")[0][0]
v_payouts = con.run("SELECT count(*) FROM public.partner_payouts;")[0][0]
v_earnings_standalone = con.run("SELECT count(*) FROM public.earnings;")[0][0]
v_commission_standalone = con.run("SELECT count(*) FROM public.commission_records;")[0][0]
v_support_partner = con.run("SELECT count(*) FROM public.support_tickets;")[0][0]
v_support_msgs_partner = con.run("SELECT count(*) FROM public.support_messages;")[0][0]
v_vehicles = con.run("SELECT count(*) FROM public.vehicles;")[0][0]
v_shops = con.run("SELECT count(*) FROM public.shops;")[0][0]

print(f"  Preserved Admins: {v_admins} (Expected: 15)")
print(f"  Preserved Partners: {v_partners} (Expected: 12)")
print(f"  Remaining Customers in users: {v_customers} (Expected: 0)")
print(f"  Remaining Bookings: {v_bookings} (Expected: 0)")
print(f"  Remaining Payments: {v_payments} (Expected: 0)")
print(f"  Preserved Wallets: {v_wallets} (Expected: 9)")
print(f"  Preserved Wallet Transactions: {v_wallet_tx} (Expected: 20)")
print(f"  Preserved Payouts: {v_payouts} (Expected: 7)")
print(f"  Preserved Standalone Earnings: {v_earnings_standalone} (Expected: 19)")
print(f"  Remaining Booking Commission Records: {v_commission_standalone} (Expected: 0)")
print(f"  Preserved Partner Support Tickets: {v_support_partner} (Expected: 2)")
print(f"  Preserved Partner Support Messages: {v_support_msgs_partner} (Expected: 5)")
print(f"  Preserved Vehicles: {v_vehicles} (Expected: 46)")
print(f"  Preserved Shops: {v_shops} (Expected: 9)")

con.run("ROLLBACK;")
con.close()
print("\n=== TRANSACTION ROLLED BACK CLEANLY. ZERO LIVE MUTATIONS COMMITTED. ===")
