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

# Fetch user roles
users = dict(con.run("SELECT id::text, role FROM public.users;"))

# Fetch all objects under customers/ in both buckets
rows = con.run("""
SELECT bucket_id, split_part(name, '/', 2) as uuid, count(*), sum((metadata->>'size')::bigint)
FROM storage.objects
WHERE split_part(name, '/', 1) = 'customers'
GROUP BY 1, 2
ORDER BY 2, 1;
""")

matrix = {}
for b_id, uid, cnt, size in rows:
    matrix.setdefault(uid, {})[b_id] = (cnt, size)

print(f"{'UUID':<38} | {'ROLE in DB':<12} | {'gongo-customers':<18} | {'gongo-uploads':<18} | {'TOTAL FILES'}")
print("-" * 105)

grand_gc = 0
grand_gu = 0
cust_gc = 0
cust_gu = 0
noncust_gc = 0
noncust_gu = 0

for uid in sorted(matrix.keys()):
    role = users.get(uid, "ORPHAN/UNKNOWN")
    gc_cnt, gc_sz = matrix[uid].get("gongo-customers", (0, 0))
    gu_cnt, gu_sz = matrix[uid].get("gongo-uploads", (0, 0))
    tot = gc_cnt + gu_cnt
    
    grand_gc += gc_cnt
    grand_gu += gu_cnt
    if role.lower() == "customer":
        cust_gc += gc_cnt
        cust_gu += gu_cnt
    else:
        noncust_gc += gc_cnt
        noncust_gu += gu_cnt

    print(f"{uid:<38} | {role:<12} | {gc_cnt:>5} ({gc_sz:>8} B) | {gu_cnt:>5} ({gu_sz:>8} B) | {tot:>5}")

print("-" * 105)
print(f"TOTAL UNDER customers/ PATH:            | gongo-cust: {grand_gc:<5}   | gongo-upld: {grand_gu:<5}   | Total: {grand_gc + grand_gu}")
print(f"  -> Verified Customer Role:            | gongo-cust: {cust_gc:<5}   | gongo-upld: {cust_gu:<5}   | Total: {cust_gc + cust_gu}")
print(f"  -> Non-Customer / Staff / Partner:    | gongo-cust: {noncust_gc:<5}   | gongo-upld: {noncust_gu:<5}   | Total: {noncust_gc + noncust_gu}")

con.close()
