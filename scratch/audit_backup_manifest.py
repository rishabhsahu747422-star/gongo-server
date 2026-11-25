import json

backup_path = r"server\backups\gongo_backup_pre_cleanup_20261123_160038.json"
manifest_path = r"server\backups\customer_purge_manifest_20261123_160038.json"

with open(backup_path, "r", encoding="utf-8") as f:
    backup_data = json.load(f)

print("--- Backup File Analysis ---")
print("Top-level keys:", list(backup_data.keys()))
if "metadata" in backup_data:
    print("Metadata:", backup_data["metadata"])

tables = backup_data.get("tables", {})
print(f"Number of tables in backup: {len(tables)}")
total_rows = sum(len(rows) for rows in tables.values())
print(f"Total rows in backup: {total_rows}")

table_summary = {}
for t, rows in tables.items():
    table_summary[t] = len(rows)

print("\nSample of tables and row counts in backup:")
for t in sorted(table_summary.keys())[:20]:
    print(f"  {t}: {table_summary[t]}")

# Check if DDL / schema / constraints / triggers exist in backup_data
has_schema = "schema" in backup_data or "ddl" in backup_data
print("\nDoes backup contain DDL / schema / constraints definitions?", has_schema)

print("\n--- Purge Manifest Analysis ---")
with open(manifest_path, "r", encoding="utf-8") as f:
    manifest_data = json.load(f)

print("Manifest keys:", list(manifest_data.keys()))
print("Customer accounts count:", manifest_data.get("customer_accounts_count"))
print("Customer IDs count:", len(manifest_data.get("customer_ids", [])))
print("Customer Auth IDs count:", len(manifest_data.get("customer_auth_ids", [])))
print("Customer Storage files count:", manifest_data.get("customer_storage_files_count"))
print("Customer Storage total bytes:", manifest_data.get("customer_storage_total_bytes"))

# Group storage files in manifest by bucket
manifest_buckets = {}
for f in manifest_data.get("customer_storage_files", []):
    b = f["bucket"]
    manifest_buckets[b] = manifest_buckets.get(b, 0) + 1
print("Storage files by bucket in manifest:", manifest_buckets)
