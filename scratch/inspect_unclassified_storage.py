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

# 1. Unclassified in gongo-customers
print("--- Objects in gongo-customers NOT in verified customer/partner/staff folders ---")
gc_unclassified = con.run("""
SELECT name, (metadata->>'size')::bigint 
FROM storage.objects 
WHERE bucket_id = 'gongo-customers'
  AND split_part(name, '/', 2) NOT IN (SELECT id::text FROM public.users);
""")
for r in gc_unclassified:
    print(" ", r)

# 2. Check all folders in gongo-customers
print("\n--- All distinct UUIDs/prefixes in gongo-customers ---")
gc_prefixes = con.run("""
SELECT split_part(name, '/', 1) as p1, split_part(name, '/', 2) as p2, count(*)
FROM storage.objects
WHERE bucket_id = 'gongo-customers'
GROUP BY 1, 2;
""")
for r in gc_prefixes:
    print(" ", r)

# 3. Sample of unclassified in gongo-uploads (the 44 files)
print("\n--- Summary of prefixes in gongo-uploads ---")
gu_prefixes = con.run("""
SELECT split_part(name, '/', 1) as prefix, count(*), sum((metadata->>'size')::bigint)
FROM storage.objects
WHERE bucket_id = 'gongo-uploads'
GROUP BY 1;
""")
for r in gu_prefixes:
    print(" ", r)

con.close()
