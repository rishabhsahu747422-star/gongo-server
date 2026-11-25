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

# Check all foreign keys referencing bookings
fks_bookings = con.run("""
SELECT
    tc.table_name, kcu.column_name, ccu.column_name AS foreign_column_name, rc.delete_rule
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.referential_constraints AS rc ON tc.constraint_name = rc.constraint_name
JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name
WHERE ccu.table_name = 'bookings'
ORDER BY tc.table_name;
""")
print("Foreign keys referencing bookings:")
for r in fks_bookings:
    cnt = con.run(f"SELECT count(*) FROM public.{r[0]};")[0][0]
    print(f"  {r[0]}.{r[1]} -> bookings.{r[2]} ({r[3]}), row count in table: {cnt}")

# Check all foreign keys referencing payments
fks_payments = con.run("""
SELECT
    tc.table_name, kcu.column_name, ccu.column_name AS foreign_column_name, rc.delete_rule
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.referential_constraints AS rc ON tc.constraint_name = rc.constraint_name
JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name
WHERE ccu.table_name = 'payments'
ORDER BY tc.table_name;
""")
print("\nForeign keys referencing payments:")
for r in fks_payments:
    cnt = con.run(f"SELECT count(*) FROM public.{r[0]};")[0][0]
    print(f"  {r[0]}.{r[1]} -> payments.{r[2]} ({r[3]}), row count in table: {cnt}")

con.close()
