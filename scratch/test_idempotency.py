import csv
import json
import shutil
import os

CSV_FILE = "finman_2026-09-02.csv"
PREVIEW_JSON = "scratch/phase5_conversion_preview.json"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    r1 = list(csv.DictReader(f))

with open(PREVIEW_JSON, "r", encoding="utf-8") as f:
    conversions = json.load(f)

conv_map = {c["SourceFinManTransactionID"]: c for c in conversions}

# Apply again
changes = 0
for r in r1:
    rid = r.get("ID")
    if rid in conv_map:
        c = conv_map[rid]
        # Check if already has exact values
        if r.get("InvestmentTransactionType") != "BUY" or r.get("Quantity") != str(c["CASUnits"]) or r.get("UnitPrice") != str(c["CASNAV"]):
            changes += 1

print(f"Idempotency check: {changes} rows would change on second run (Expected: 0)")
assert changes == 0, "Idempotency failed: changes detected on second run!"
print("IDEMPOTENCY VERIFIED 100%!")
