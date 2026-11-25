import json
import os
import urllib.parse
import pg8000.native
import datetime

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
    timeout=120
)

timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
backup_dir = r"server\backups"
os.makedirs(backup_dir, exist_ok=True)

# ---------------------------------------------------------
# PHASE A: BACKUP GENERATION
# ---------------------------------------------------------
print("=== PHASE A: GENERATING COMPLETE DATABASE BACKUP ===")
con.run("SET default_transaction_read_only = on;")
con.run("BEGIN READ ONLY;")

tables_res = con.run("""
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name;
""")
all_tables = [r[0] for r in tables_res]

backup_data = {
    "exported_at": datetime.datetime.now().isoformat(),
    "database": "postgres",
    "tables_count": len(all_tables),
    "tables": {}
}

total_rows_backed_up = 0

for t in all_tables:
    cols_res = con.run(f"""
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = '{t}'
        ORDER BY ordinal_position;
    """)
    col_names = [c[0] for c in cols_res]
    
    rows = con.run(f'SELECT * FROM public."{t}";')
    
    # serialize rows
    serialized_rows = []
    for r in rows:
        row_dict = {}
        for idx, val in enumerate(r):
            # serialize dates/uuids
            if isinstance(val, (datetime.date, datetime.datetime)):
                row_dict[col_names[idx]] = val.isoformat()
            else:
                row_dict[col_names[idx]] = val
        serialized_rows.append(row_dict)
    
    backup_data["tables"][t] = serialized_rows
    if len(serialized_rows) > 0:
        total_rows_backed_up += len(serialized_rows)

con.run("ROLLBACK;")

# Save JSON backup
backup_json_path = os.path.join(backup_dir, f"gongo_complete_backup_{timestamp}.json")
with open(backup_json_path, "w", encoding="utf-8") as f:
    json.dump(backup_data, f, indent=2)

backup_size = os.path.getsize(backup_json_path)
print(f"Backup JSON created: {backup_json_path}")
print(f"  Total tables backed up: {len(all_tables)}")
print(f"  Total rows backed up: {total_rows_backed_up}")
print(f"  File size: {backup_size / 1024:.2f} KB")

# ---------------------------------------------------------
# GENERATE CUSTOMER MANIFEST
# ---------------------------------------------------------
print("\n=== GENERATING CUSTOMER IDENTITY & STORAGE MANIFEST ===")
con.run("BEGIN READ ONLY;")

# 1. Customer user IDs
cust_rows = con.run("""
    SELECT id::text, auth_id, created_at, role
    FROM public.users
    WHERE LOWER(role) = 'customer';
""")

customer_ids = [r[0] for r in cust_rows]
customer_auth_ids = [r[1] for r in cust_rows if r[1] is not None]

# 2. Check Auth user mapping
auth_customer_matches = con.run("""
    SELECT a.id::text, a.email, a.phone, a.created_at
    FROM auth.users a
    WHERE a.id::text IN (
      SELECT auth_id FROM public.users WHERE LOWER(role) = 'customer' AND auth_id IS NOT NULL
    );
""")

# 3. Storage objects belonging strictly to customer UUID folders
storage_objs = con.run("""
    SELECT bucket_id, name, (metadata->>'size')::bigint AS size
    FROM storage.objects
    WHERE name LIKE 'customers/%';
""")

customer_files = []
preserved_partner_admin_files = []

for obj in storage_objs:
    b = obj[0]
    name = obj[1]
    size = obj[2]
    parts = name.split('/')
    folder_uuid = parts[1] if len(parts) > 1 else ""
    
    if folder_uuid in customer_ids:
        customer_files.append({"bucket": b, "name": name, "size": size, "customer_id": folder_uuid})
    else:
        preserved_partner_admin_files.append({"bucket": b, "name": name, "size": size, "folder_uuid": folder_uuid})

con.run("ROLLBACK;")

manifest = {
    "generated_at": datetime.datetime.now().isoformat(),
    "customer_accounts_count": len(customer_ids),
    "customer_ids": customer_ids,
    "customer_auth_identities_count": len(auth_customer_matches),
    "customer_auth_ids": [r[0] for r in auth_customer_matches],
    "customer_storage_files_count": len(customer_files),
    "customer_storage_total_bytes": sum(f['size'] for f in customer_files if f['size']),
    "customer_storage_files": customer_files,
    "preserved_non_customer_storage_files_count": len(preserved_partner_admin_files),
    "preserved_non_customer_storage_files": preserved_partner_admin_files
}

manifest_path = os.path.join(backup_dir, f"customer_purge_manifest_{timestamp}.json")
with open(manifest_path, "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2)

print(f"Manifest created: {manifest_path}")
print(f"  Customer accounts identified: {len(customer_ids)}")
print(f"  Customer Auth identities identified: {len(auth_customer_matches)}")
print(f"  Customer Storage files identified: {len(customer_files)} ({manifest['customer_storage_total_bytes']/1024:.2f} KB)")
print(f"  Preserved non-customer files under customers/: {len(preserved_partner_admin_files)}")

# ---------------------------------------------------------
# PHASE B: TRANSACTIONAL DRY RUN WITH ROLLBACK
# ---------------------------------------------------------
print("\n=== PHASE B: EXECUTING TRANSACTIONAL DRY RUN (WITH ROLLBACK) ===")
con.run("SET default_transaction_read_only = off;")
con.run("BEGIN;")

dry_run_log = []

def run_dry_del(label, sql):
    res = con.run(sql)
    cnt = con.run("SELECT count(*) FROM ( " + sql.replace("DELETE FROM", "SELECT * FROM") + " ) AS t;")[0][0]
    return cnt

# We can execute DELETE queries and check rows affected
queries = [
    # 1. Ephemeral KYC & Verification
    ("customer_identity_links", "DELETE FROM public.customer_identity_links WHERE customer_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer');"),
    ("identity_verification_audits", "DELETE FROM public.identity_verification_audits WHERE customer_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer');"),
    ("customer_identity_verifications", "DELETE FROM public.customer_identity_verifications WHERE customer_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer');"),
    ("customer_documents", "DELETE FROM public.customer_documents WHERE user_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer');"),
    ("customer_device_tokens", "DELETE FROM public.customer_device_tokens WHERE customer_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer');"),
    ("customer_profiles", "DELETE FROM public.customer_profiles WHERE user_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer');"),
    ("notifications", "DELETE FROM public.notifications WHERE customer_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer');"),
    ("idempotency_keys", "DELETE FROM public.idempotency_keys WHERE user_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer');"),
    
    # 2. Customer Support Ticket Data (1 customer ticket, 6 messages, 3 history)
    ("support_messages (customer)", """
        DELETE FROM public.support_messages 
        WHERE ticket_id::text IN (
          SELECT id::text FROM public.support_tickets 
          WHERE customer_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer')
             OR (user_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer') AND partner_id IS NULL)
        );
    """),
    ("ticket_status_history (customer)", """
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
    ("payment_attempts", "DELETE FROM public.payment_attempts WHERE payment_id::text IN (SELECT id::text FROM public.payments) OR booking_id::text IN (SELECT id::text FROM public.bookings);"),
    ("payments", "DELETE FROM public.payments;"),
    ("commission_records (linked to bookings)", "DELETE FROM public.commission_records WHERE booking_id::text IN (SELECT id::text FROM public.bookings);"),
    ("earnings (linked to bookings)", "DELETE FROM public.earnings WHERE booking_id::text IN (SELECT id::text FROM public.bookings);"),

    # 5. Core Bookings
    ("bookings (ALL 36 bookings)", "DELETE FROM public.bookings;"),

    # 6. Customer Users
    ("users (customer accounts only)", "DELETE FROM public.users WHERE LOWER(role) = 'customer';")
]

dry_run_results = []
for label, sql in queries:
    # get count before delete
    # execute delete
    con.run(sql)
    dry_run_results.append(label)
    print(f"  [DRY-RUN DELETED] {label}")

# Validate Post-Cleanup State inside transaction
print("\n--- Validating Post-Cleanup Preservation Inside Transaction ---")
v_admins = con.run("SELECT count(*) FROM public.users WHERE LOWER(role) IN ('admin', 'super_admin', 'support_executive');")[0][0]
v_partners = con.run("SELECT count(*) FROM public.users WHERE LOWER(role) = 'partner';")[0][0]
v_customers = con.run("SELECT count(*) FROM public.users WHERE LOWER(role) = 'customer';")[0][0]
v_bookings = con.run("SELECT count(*) FROM public.bookings;")[0][0]
v_payments = con.run("SELECT count(*) FROM public.payments;")[0][0]
v_wallets = con.run("SELECT count(*) FROM public.partner_wallets;")[0][0]
v_wallet_tx = con.run("SELECT count(*) FROM public.wallet_transactions;")[0][0]
v_payouts = con.run("SELECT count(*) FROM public.partner_payouts;")[0][0]
v_earnings_standalone = con.run("SELECT count(*) FROM public.earnings;")[0][0]
v_support_partner = con.run("SELECT count(*) FROM public.support_tickets;")[0][0]
v_support_msgs_partner = con.run("SELECT count(*) FROM public.support_messages;")[0][0]
v_vehicles = con.run("SELECT count(*) FROM public.vehicles;")[0][0]
v_shops = con.run("SELECT count(*) FROM public.shops;")[0][0]

print(f"  Preserved Admins: {v_admins} (Expected: 15)")
print(f"  Preserved Partners: {v_partners} (Expected: 12)")
print(f"  Remaining Customers: {v_customers} (Expected: 0)")
print(f"  Remaining Bookings: {v_bookings} (Expected: 0)")
print(f"  Remaining Payments: {v_payments} (Expected: 0)")
print(f"  Preserved Wallets: {v_wallets} (Expected: 9)")
print(f"  Preserved Wallet Transactions: {v_wallet_tx} (Expected: 20)")
print(f"  Preserved Payouts: {v_payouts} (Expected: 7)")
print(f"  Preserved Standalone Earnings: {v_earnings_standalone} (Expected: 19)")
print(f"  Preserved Partner Support Tickets: {v_support_partner} (Expected: 2)")
print(f"  Preserved Partner Support Messages: {v_support_msgs_partner} (Expected: 5)")
print(f"  Preserved Vehicles: {v_vehicles} (Expected: 46)")
print(f"  Preserved Shops: {v_shops} (Expected: 9)")

# ROLLBACK TRANSACTION
con.run("ROLLBACK;")
con.close()
print("\n=== TRANSACTION ROLLED BACK CLEANLY. ZERO DATABASE MUTATIONS COMMITTED. ===")
