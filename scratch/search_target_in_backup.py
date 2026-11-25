import json

backup_path = r"server\backups\gongo_backup_pre_cleanup_20261123_160038.json"
with open(backup_path, "r", encoding="utf-8") as f:
    text = f.read()

target = "8106aad1-519e-45e6-ace6-eccc32bc38e6"
print(f"Occurrences of {target} in backup JSON: {text.count(target)}")

# If found, where?
with open(backup_path, "r", encoding="utf-8") as f:
    data = json.load(f)

for t, rows in data.get("tables", {}).items():
    for r in rows:
        row_str = str(r)
        if target in row_str:
            print(f"Found in table {t}: {r}")
