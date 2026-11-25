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

# 1. Who was created by 2adaa1f2-1d92-43cc-88bd-cd6f88d0f507?
created_users = con.run("""
SELECT id, role, created_at, created_by 
FROM public.users 
WHERE created_by = '2adaa1f2-1d92-43cc-88bd-cd6f88d0f507';
""")
print("Users created by 2adaa1f2-1d92-43cc-88bd-cd6f88d0f507:")
for u in created_users:
    print(" ", u)

# 2. Inspect admin_actions detail
aa = con.run("""
SELECT id, actor_id, actor_role, action, target_type, target_id, target_resource, target_resource_id, metadata
FROM public.admin_actions 
WHERE actor_id = '2adaa1f2-1d92-43cc-88bd-cd6f88d0f507';
""")
print("Admin actions details for actor_id = 2adaa1f2-1d92-43cc-88bd-cd6f88d0f507:")
for a in aa:
    print(" ", a)

con.close()
