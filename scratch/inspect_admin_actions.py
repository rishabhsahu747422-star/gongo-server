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

cols = con.run("""
SELECT column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'admin_actions';
""")
print("Columns of admin_actions:")
for r in cols:
    print(" ", r)

fks = con.run("""
SELECT
    tc.constraint_name, kcu.column_name, ccu.table_name AS foreign_table_name,
    ccu.column_name AS foreign_column_name, rc.delete_rule
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.referential_constraints AS rc
  ON tc.constraint_name = rc.constraint_name
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name
WHERE tc.table_name = 'admin_actions';
""")
print("FKs of admin_actions:")
for r in fks:
    print(" ", r)

rows = con.run("""
SELECT id, actor_id, target_id, action, target_type, created_at 
FROM public.admin_actions 
WHERE actor_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer')
   OR (target_id IS NOT NULL AND target_id::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer'));
""")
print(f"Rows in admin_actions referencing customer: {len(rows)}")
for r in rows:
    print(" ", r)

all_rows = con.run("SELECT count(*) FROM public.admin_actions;")
print("Total rows in admin_actions:", all_rows[0][0])

con.close()
