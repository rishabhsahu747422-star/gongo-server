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

# 1. Inspect user 2adaa1f2-1d92-43cc-88bd-cd6f88d0f507
u = con.run("SELECT id, role, auth_id, created_at FROM public.users WHERE id = '2adaa1f2-1d92-43cc-88bd-cd6f88d0f507';")
print("User 2adaa1f2-1d92-43cc-88bd-cd6f88d0f507:", u)

# 2. Inspect admin_actions for this user
aa = con.run("SELECT id, actor_id, actor_role, admin_id, action, target_resource, created_at FROM public.admin_actions WHERE actor_id = '2adaa1f2-1d92-43cc-88bd-cd6f88d0f507' OR admin_id = '2adaa1f2-1d92-43cc-88bd-cd6f88d0f507';")
print("Admin actions matching this user:")
for r in aa:
    print(" ", r)

# 3. Find ALL foreign keys that reference public.users
fks = con.run("""
SELECT
    tc.table_schema,
    tc.table_name,
    kcu.column_name,
    ccu.table_name AS foreign_table_name,
    ccu.column_name AS foreign_column_name,
    rc.delete_rule
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.referential_constraints AS rc
  ON tc.constraint_name = rc.constraint_name
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name
WHERE ccu.table_name = 'users'
ORDER BY tc.table_name, kcu.column_name;
""")

print("\nAll Foreign Keys referencing public.users:")
for schema, tbl, col, ftbl, fcol, drule in fks:
    # Check if there are any rows referencing customer accounts in tbl.col
    try:
        cnt = con.run(f"SELECT count(*) FROM {schema}.{tbl} WHERE {col}::text IN (SELECT id::text FROM public.users WHERE LOWER(role) = 'customer');")[0][0]
        if cnt > 0:
            print(f"  FOUND: {tbl}.{col} -> users.{fcol} (delete_rule: {drule}) has {cnt} rows referencing customer!")
        else:
            # print(f"  Empty/0: {tbl}.{col}")
            pass
    except Exception as e:
        print(f"  ERROR checking {tbl}.{col}: {e}")

con.close()
