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

uuid_target = '8106aad1-519e-45e6-ace6-eccc32bc38e6'

# Check auth.users
try:
    auth_u = con.run(f"SELECT id, email, created_at, raw_user_meta_data FROM auth.users WHERE id = '{uuid_target}';")
    print(f"Found in auth.users: {auth_u}")
except Exception as e:
    print(f"auth.users query error: {e}")

# Check public tables for this UUID
tables_with_uuid = []
pop_tables = con.run("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';")
for (t,) in pop_tables:
    try:
        # Check text search in table
        cnt = con.run(f"SELECT count(*) FROM public.{t} WHERE '{uuid_target}' = ANY(ARRAY[id::text]);")[0][0]
        if cnt > 0:
            tables_with_uuid.append(t)
    except Exception:
        pass

print(f"Tables in public matching ID {uuid_target}: {tables_with_uuid}")

# Check gongo-uploads customers prefixes
gu_cust_uuids = con.run("""
SELECT split_part(name, '/', 2), count(*)
FROM storage.objects
WHERE bucket_id = 'gongo-uploads' AND split_part(name, '/', 1) = 'customers'
GROUP BY 1;
""")
print("\nDistinct UUIDs under gongo-uploads/customers/:")
for r in gu_cust_uuids:
    print(" ", r)

con.close()
