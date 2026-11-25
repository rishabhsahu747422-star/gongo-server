import json
import urllib.request
import urllib.error

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

supabase_url = config.get("SUPABASE_URL")
service_key = config.get("SUPABASE_SERVICE_ROLE_KEY")

# Check Auth User
auth_user_id = "d52a61be-8add-4467-8841-3aee1ef98670"
req = urllib.request.Request(
    f"{supabase_url}/auth/v1/admin/users/{auth_user_id}",
    headers={
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}"
    }
)

try:
    with urllib.request.urlopen(req) as resp:
        user_data = json.loads(resp.read().decode('utf-8'))
        print(f"Auth user {auth_user_id} found: created_at={user_data.get('created_at')}, email={user_data.get('email')}")
except Exception as e:
    print(f"Error fetching auth user: {e}")

# Check Storage Manifest
manifest_file = r"c:\Users\risha\Downloads\Gongo\gongo adhar\GONGO-V1\server\backups\customer_purge_manifest_20261123_160038.json"
with open(manifest_file, "r", encoding="utf-8") as f:
    manifest = json.load(f)

print(f"Storage manifest loaded:")
print(f"  Total customer files to delete: {manifest['customer_storage_files_count']}")
print(f"  Total bytes: {manifest['customer_storage_total_bytes']} ({manifest['customer_storage_total_bytes'] / (1024*1024):.2f} MB)")
