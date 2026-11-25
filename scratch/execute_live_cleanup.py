import json
import os
import urllib.parse
import urllib.request
import urllib.error
import pg8000.native

# 1. Load Environment Configuration
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
supabase_url = config.get("SUPABASE_URL")
service_key = config.get("SUPABASE_SERVICE_ROLE_KEY")

manifest_file = r"c:\Users\risha\Downloads\Gongo\gongo adhar\GONGO-V1\server\backups\customer_purge_manifest_20261123_160038.json"
with open(manifest_file, "r", encoding="utf-8") as f:
    manifest = json.load(f)

parsed = urllib.parse.urlparse(db_url)

print("="*70)
print("GONGO — LIVE CUSTOMER APP DATA PURGE EXECUTION")
print("="*70)

# 2. Database Execution
print("\n[STEP 1/3] Connecting to PostgreSQL and executing Atomic Database Transaction...")
con = pg8000.native.Connection(
    user=parsed.username,
    password=parsed.password,
    host=parsed.hostname,
    port=parsed.port or 5432,
    database=parsed.path.lstrip('/'),
    ssl_context=True,
    timeout=60
)

try:
    con.run("SET default_transaction_read_only = off;")
    con.run("BEGIN;")

    queries = [
        # 1. Customer KYC and Profile Data
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
        print(f"  [SUCCESS] {label}")

    # Validate Post-Cleanup State inside transaction before committing
    print("\n  Validating Post-Cleanup Invariants...")
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

    assert v_admins == 15, f"Admin count invariant failed: {v_admins} != 15"
    assert v_partners == 12, f"Partner count invariant failed: {v_partners} != 12"
    assert v_customers == 0, f"Customer count invariant failed: {v_customers} != 0"
    assert v_bookings == 0, f"Bookings count invariant failed: {v_bookings} != 0"
    assert v_payments == 0, f"Payments count invariant failed: {v_payments} != 0"
    assert v_wallets == 9, f"Wallets invariant failed: {v_wallets} != 9"
    assert v_wallet_tx == 20, f"Wallet tx invariant failed: {v_wallet_tx} != 20"
    assert v_payouts == 7, f"Payouts invariant failed: {v_payouts} != 7"
    assert v_earnings_standalone == 19, f"Standalone earnings invariant failed: {v_earnings_standalone} != 19"
    assert v_commission_standalone == 0, f"Commission invariant failed: {v_commission_standalone} != 0"
    assert v_support_partner == 2, f"Partner support tickets invariant failed: {v_support_partner} != 2"
    assert v_support_msgs_partner == 5, f"Partner support messages invariant failed: {v_support_msgs_partner} != 5"
    assert v_vehicles == 46, f"Vehicles invariant failed: {v_vehicles} != 46"
    assert v_shops == 9, f"Shops invariant failed: {v_shops} != 9"

    con.run("COMMIT;")
    print("  >>> TRANSACTION COMMITTED SUCCESSFULLY. DATABASE PURGE COMPLETE. <<<")

except Exception as e:
    con.run("ROLLBACK;")
    print(f"  !!! ERROR: Transaction aborted and rolled back: {e}")
    raise
finally:
    con.close()

# 3. Supabase Auth Admin API Purge
print("\n[STEP 2/3] Deleting Customer Supabase Auth Identities via Admin API...")
for auth_id in manifest.get("customer_auth_ids", []):
    req = urllib.request.Request(
        f"{supabase_url}/auth/v1/admin/users/{auth_id}",
        headers={
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}"
        },
        method="DELETE"
    )
    try:
        with urllib.request.urlopen(req) as resp:
            print(f"  [DELETED AUTH USER] {auth_id} (HTTP {resp.status})")
    except urllib.error.HTTPError as e:
        print(f"  [ERROR DELETING AUTH USER] {auth_id}: {e.code} {e.reason}")

# 4. Supabase Storage API Purge
print("\n[STEP 3/3] Deleting Customer Files from Supabase Storage...")
# Group by bucket
files_by_bucket = {}
for item in manifest.get("customer_storage_files", []):
    b = item["bucket"]
    files_by_bucket.setdefault(b, []).append(item["name"])

for bucket, prefixes in files_by_bucket.items():
    print(f"  Processing bucket '{bucket}' ({len(prefixes)} files)...")
    # Batch delete up to 100 files per call
    batch_size = 50
    for i in range(0, len(prefixes), batch_size):
        batch = prefixes[i:i+batch_size]
        payload = json.dumps({"prefixes": batch}).encode("utf-8")
        req = urllib.request.Request(
            f"{supabase_url}/storage/v1/object/{bucket}",
            data=payload,
            headers={
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "Content-Type": "application/json"
            },
            method="DELETE"
        )
        try:
            with urllib.request.urlopen(req) as resp:
                res_data = json.loads(resp.read().decode("utf-8"))
                print(f"    Deleted batch {i//batch_size + 1}: {len(batch)} files")
        except urllib.error.HTTPError as e:
            print(f"    [ERROR DELETING STORAGE BATCH]: {e.code} {e.reason} - {e.read().decode('utf-8')}")

print("\n" + "="*70)
print("GONGO CUSTOMER APP DATA PURGE COMPLETED SUCCESSFULLY!")
print("="*70)
