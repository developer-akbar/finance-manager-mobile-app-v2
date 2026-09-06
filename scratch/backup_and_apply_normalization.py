import csv
import shutil
import os

CSV_FILE = "finman_2026-09-02.csv"
BACKUP_FILE = "scratch/finman_2026-09-02.csv.bak"

# 1. Create safety backup
shutil.copyfile(CSV_FILE, BACKUP_FILE)
print(f"Backup created at: {BACKUP_FILE} ({os.path.getsize(BACKUP_FILE)} bytes)")

# 2. Read with DictReader
with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    reader = csv.DictReader(f)
    fieldnames = reader.fieldnames
    rows = list(reader)

print(f"Read {len(rows)} rows from {CSV_FILE}")

TARGET_MODS = {
  # 1. Ammi cashback (3 transactions)
  "c24bc7db-14f6-4e3d-8752-f5a243d48d45": ("Ammi Groww", "6125"),
  "c4843272-3289-4a41-ac3b-59e552377384": ("Ammi Groww", "4901"),
  "a710ce84-4979-4d31-8537-6060225dd292": ("Ammi Groww", "4232"),
  # 2. Fareeda ETMoney (8 transactions)
  "6075a44d-a7af-4885-9ae7-8457c3420666": ("Fareeda ETMoney", "6404"),
  "70bc6df2-f39b-44e1-9795-1f4ca58f0b7b": ("Fareeda ETMoney", "6405"),
  "78fc33c4-33ee-49e5-ad8b-6d074f8fdf3a": ("Fareeda ETMoney", "6577"),
  "be603713-6b6d-48fe-be34-e9254f7b6d86": ("Fareeda ETMoney", "6578"),
  "7cf8ce64-9fc8-4790-b207-6cc616b79d57": ("Fareeda ETMoney", "6579"),
  "efdcd0b6-ffb7-4fe4-aa9b-05d26c010f61": ("Fareeda ETMoney", "6580"),
  "540accf4-76b8-4f76-abfd-02305949ddbd": ("Fareeda ETMoney", "6581"),
  "84310067-22a3-4714-9381-5bab6f16cde2": ("Fareeda ETMoney", "6582"),
}

modified_count = 0
for r in rows:
    rid = r.get("ID")
    if rid in TARGET_MODS:
        target_sub, label = TARGET_MODS[rid]
        r["SubAccount"] = target_sub
        if r.get("ToAccount") == "Liquid Mutual Funds":
            r["ToSubAccount"] = target_sub
        if r.get("FromAccount") == "Liquid Mutual Funds":
            r["FromSubAccount"] = target_sub
        modified_count += 1
        print(f"Updated row {label} (ID: {rid[:8]}): SubAccount -> '{target_sub}'")

print(f"\nTotal rows modified: {modified_count}")
assert modified_count == 11, f"Expected 11 modifications, but got {modified_count}"

# 3. Write back cleanly using csv.DictWriter
with open(CSV_FILE, "w", encoding="utf-8-sig", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(rows)

print(f"Successfully wrote normalized dataset back to {CSV_FILE}")

