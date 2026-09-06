import csv
import json

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

# Let's verify row line numbers, amounts, IDs, and match details
with open("scratch/lmf_audit_rows.json", "r", encoding="utf-8") as f:
    audit_rows = json.load(f)

print(f"Total audit rows: {len(audit_rows)}")

# Check platform corrections:
# Find rows where sub is Fareeda Groww (or empty) but desc/note says Fareeda ETMoney
platform_corrections = []
for r in audit_rows:
    sub = r["sub"]
    desc = r["desc"].lower()
    note = r["note"].lower()
    text = f"{desc} {note}"
    
    if ("etmoney" in text or "et money" in text) and sub == "Fareeda Groww":
        platform_corrections.append(r)
    elif ("etmoney" in text or "et money" in text) and not sub:
        platform_corrections.append(r)

print(f"Platform corrections count: {len(platform_corrections)}")
for pc in platform_corrections:
    print(f"Line {pc['line']:5d} | Date: {pc['date']} | CurrSub: '{pc['sub']}' | Proposed: 'Fareeda ETMoney' | Amt: {pc['amt']} | Note: {pc['note']} | Desc: {pc['desc'][:30]}")
