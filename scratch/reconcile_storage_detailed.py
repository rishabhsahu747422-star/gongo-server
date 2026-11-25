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

parsed = urllib.parse.urlparse(config.get("DATABASE_URL"))
con = pg8000.native.Connection(
    user=parsed.username,
    password=parsed.password,
    host=parsed.hostname,
    port=parsed.port or 5432,
    database=parsed.path.lstrip('/'),
    ssl_context=True,
    timeout=30
)

# 1. Inspect storage.buckets
buckets = con.run("SELECT id, name, public, created_at FROM storage.buckets;")
print("Storage Buckets:")
for b in buckets:
    print(" ", b)

# 2. Inspect storage.objects per bucket
print("\nStorage Objects count per bucket:")
counts = con.run("SELECT bucket_id, count(*), sum((metadata->>'size')::bigint) FROM storage.objects GROUP BY bucket_id;")
for c in counts:
    print(f"  Bucket '{c[0]}': {c[1]} objects, {c[2]} bytes")

# 3. List all objects in storage.objects with bucket_id and name
all_objects = con.run("SELECT bucket_id, name, (metadata->>'size')::bigint FROM storage.objects ORDER BY bucket_id, name;")

# Get verified customer user IDs
customer_ids = set(r[0] for r in con.run("SELECT id::text FROM public.users WHERE LOWER(role) = 'customer';"))
partner_ids = set(r[0] for r in con.run("SELECT id::text FROM public.users WHERE LOWER(role) = 'partner';"))
staff_ids = set(r[0] for r in con.run("SELECT id::text FROM public.users WHERE LOWER(role) IN ('admin', 'super_admin', 'support_executive');"))

print(f"\nVerified DB user counts: {len(customer_ids)} customers, {len(partner_ids)} partners, {len(staff_ids)} staff")

classification = {
    "gongo-customers": {"customer": [], "partner_staff": [], "unclassified": []},
    "gongo-uploads": {"customer": [], "partner_staff": [], "unclassified": []},
    "gongo-partner-documents": {"files": []},
    "other": {}
}

for b_id, name, size in all_objects:
    if b_id == "gongo-partner-documents":
        classification["gongo-partner-documents"]["files"].append((name, size))
    elif b_id in ("gongo-customers", "gongo-uploads"):
        # Check folder structure: usually 'customers/<uuid>/...'
        parts = name.split("/")
        first_segment = parts[0]
        second_segment = parts[1] if len(parts) > 1 else None
        
        if first_segment == "customers" and second_segment:
            if second_segment in customer_ids:
                classification[b_id]["customer"].append((name, size, second_segment))
            elif second_segment in partner_ids or second_segment in staff_ids:
                classification[b_id]["partner_staff"].append((name, size, second_segment))
            else:
                classification[b_id]["unclassified"].append((name, size, second_segment))
        else:
            classification[b_id]["unclassified"].append((name, size, None))
    else:
        classification["other"].setdefault(b_id, []).append((name, size))

print("\n--- EXACT STORAGE OBJECT CLASSIFICATION ---")
print(f"1. gongo-customers:")
print(f"   Customer files: {len(classification['gongo-customers']['customer'])}")
print(f"   Partner/Staff files: {len(classification['gongo-customers']['partner_staff'])}")
print(f"   Unclassified files: {len(classification['gongo-customers']['unclassified'])}")
total_gc = len(classification['gongo-customers']['customer']) + len(classification['gongo-customers']['partner_staff']) + len(classification['gongo-customers']['unclassified'])
print(f"   Total in gongo-customers: {total_gc}")

print(f"\n2. gongo-uploads:")
print(f"   Customer files: {len(classification['gongo-uploads']['customer'])}")
print(f"   Partner/Staff files: {len(classification['gongo-uploads']['partner_staff'])}")
print(f"   Unclassified files: {len(classification['gongo-uploads']['unclassified'])}")
total_gu = len(classification['gongo-uploads']['customer']) + len(classification['gongo-uploads']['partner_staff']) + len(classification['gongo-uploads']['unclassified'])
print(f"   Total in gongo-uploads: {total_gu}")

print(f"\n3. gongo-partner-documents:")
print(f"   Total files: {len(classification['gongo-partner-documents']['files'])}")

print(f"\n4. Combined Customer vs Preserved across gongo-customers + gongo-uploads:")
total_cust = len(classification['gongo-customers']['customer']) + len(classification['gongo-uploads']['customer'])
total_partner_staff = len(classification['gongo-customers']['partner_staff']) + len(classification['gongo-uploads']['partner_staff'])
print(f"   Total verified Customer files: {total_cust}")
print(f"   Total verified Partner/Staff files under customers/ path: {total_partner_staff}")
print(f"   Sum of both: {total_cust + total_partner_staff}")

# Inspect who the partner_staff folders belong to
print("\nPartner/Staff folders breakdown:")
for b_id in ("gongo-customers", "gongo-uploads"):
    print(f" In {b_id}:")
    by_uuid = {}
    for name, size, uid in classification[b_id]["partner_staff"]:
        by_uuid.setdefault(uid, []).append(name)
    for uid, files in by_uuid.items():
        role = "partner" if uid in partner_ids else ("staff" if uid in staff_ids else "unknown")
        print(f"   UUID {uid} ({role}): {len(files)} files")

con.close()
