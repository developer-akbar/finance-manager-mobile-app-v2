import csv
import shutil
import os

CSV_FILE = "finman_2026-09-02.csv"
BACKUP_FILE = "scratch/finman_2026-09-02.phase1.bak"

# 1. Create safety backup
shutil.copyfile(CSV_FILE, BACKUP_FILE)
print(f"Phase 1 backup created at: {BACKUP_FILE} ({os.path.getsize(BACKUP_FILE)} bytes)")

# 2. Read with DictReader
with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    reader = csv.DictReader(f)
    fieldnames = reader.fieldnames
    rows = list(reader)

print(f"Read {len(rows)} rows from {CSV_FILE}")

DSP_17_IDS = {
    "5121808e-3569-49c4-b5dd-135065db76ca": ("03/07/2023", 5000.0, 11300),
    "35199c20-83be-4d6b-b3ad-127241c5a308": ("04/08/2023", 5000.0, 10967),
    "7c9fdf01-8788-457c-b2a6-b17ff1ebb310": ("05/09/2023", 5000.0, 10640),
    "637da1f3-2676-4e23-8596-6934346b58b5": ("03/10/2023", 5000.0, 10372),
    "ca401ed4-50f4-45a6-84aa-2be06b722427": ("09/11/2023", 5000.0, 10000),
    "b8d23e14-8e24-40d3-bf7d-905ddc848562": ("04/12/2023", 5000.0, 9778),
    "a8952038-e29e-467e-a9f0-5f100ee49fef": ("08/01/2024", 5000.0, 9493),
    "10d793a1-f4af-41eb-828e-7d41865d3cd2": ("05/02/2024", 5000.0, 9258),
    "841de93e-0356-4c69-bd89-8aed6c6948bd": ("07/03/2024", 5000.0, 8981),
    "4992f3ec-ec7f-4e8a-abd0-41d5dea65cbb": ("03/04/2024", 5000.0, 8747),
    "7ac21162-604a-43c0-a868-e23c28cbdf2c": ("01/05/2024", 5000.0, 8493),
    "acd961ec-2be7-4c82-b4bb-59d75e4ae555": ("05/06/2024", 10000.0, 8213),
    "5aaf60e6-2ece-4dc6-9a0c-deeb97ed982e": ("03/07/2024", 10000.0, 7946),
    "ca66768f-b994-4aa2-9ab2-598daf44fb71": ("29/07/2024", 50000.0, 7751),
    "67e2552f-b1b0-4fc5-9819-011fc792bc58": ("27/08/2024", 100000.0, 7489),
    "e9b70da8-db53-4ec9-a0a8-56908bd148d1": ("23/09/2024", 50000.0, 7228),
    "6e55e5ac-9d2e-47c7-a16e-71c56452c3ee": ("08/10/2024", 23000.0, 6971),
}

modified_count = 0
sum_modified = 0
for r in rows:
    rid = r.get("ID")
    if rid in DSP_17_IDS:
        d_exp, amt_exp, line_lbl = DSP_17_IDS[rid]
        amt = float(r.get("Amount") or 0)
        assert amt == amt_exp, f"Amount mismatch on row {line_lbl}: expected {amt_exp}, got {amt}"
        
        r["SubAccount"] = "Fareeda ETMoney"
        if r.get("ToAccount") == "Liquid Mutual Funds":
            r["ToSubAccount"] = "Fareeda ETMoney"
        if r.get("FromAccount") == "Liquid Mutual Funds":
            r["FromSubAccount"] = "Fareeda ETMoney"
            
        modified_count += 1
        sum_modified += amt
        print(f"Updated row {line_lbl:5d} ({d_exp}): Rs. {amt:>8.2f} | SubAccount -> 'Fareeda ETMoney'")

print(f"\nTotal rows modified: {modified_count}")
print(f"Total purchase amount moved: Rs. {sum_modified:,.2f}")
assert modified_count == 17, f"Expected 17 modifications, but got {modified_count}"
assert sum_modified == 298000.0, f"Expected Rs. 298,000, but got {sum_modified}"

# 3. Write back cleanly using csv.DictWriter
with open(CSV_FILE, "w", encoding="utf-8-sig", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(rows)

print(f"Successfully wrote normalized Phase 2 dataset back to {CSV_FILE}")

