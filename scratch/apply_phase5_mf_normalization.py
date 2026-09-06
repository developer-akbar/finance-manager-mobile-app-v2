import csv
import json
import shutil
import os

CSV_FILE = "finman_2026-09-02.csv"
BACKUP_FILE = "scratch/finman_2026-09-02.phase2.bak"
PREVIEW_JSON = "scratch/phase5_conversion_preview.json"

# 1. Create safety backup of Phase 2 dataset
shutil.copyfile(CSV_FILE, BACKUP_FILE)
print(f"Phase 2 backup saved to: {BACKUP_FILE} ({os.path.getsize(BACKUP_FILE)} bytes)")

# 2. Load conversion preview
with open(PREVIEW_JSON, "r", encoding="utf-8") as f:
    conversions = json.load(f)

conv_map = {c["SourceFinManTransactionID"]: c for c in conversions}
print(f"Loaded {len(conv_map)} planned conversions from {PREVIEW_JSON}")

# 3. Read current CSV
with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    reader = csv.DictReader(f)
    fieldnames = reader.fieldnames
    rows = list(reader)

print(f"Read {len(rows)} transactions from {CSV_FILE}")

# 4. Apply conversions
converted_count = 0
for r in rows:
    rid = r.get("ID")
    if rid in conv_map:
        c = conv_map[rid]
        r["InvestmentTransactionType"] = "BUY"
        r["Brokerage"] = c["SubAccount"]
        r["SubAccount"] = c["SubAccount"]
        r["ToSubAccount"] = c["SubAccount"]
        r["SecuritySymbol"] = c["SecuritySymbol"]
        r["SecurityISIN"] = c["SecurityISIN"]
        r["Quantity"] = str(c["CASUnits"])
        r["UnitPrice"] = str(c["CASNAV"])
        r["TradeValue"] = str(c["CASGrossAmount"]) if c["OwnershipTag"] != "FATHER_EXTERNAL" else "0"
        r["CostBasis"] = str(c["NetInvestmentAmount"])
        r["CashImpact"] = "0"
        r["PositionQuantityChange"] = str(c["PositionQuantityChange"])
        r["RealizedPnl"] = "0"
        r["Source"] = "CAMS_CAS"
        r["Tags"] = c["Tags"]
        r["Note"] = c["SchemeNote"]
        converted_count += 1

print(f"Successfully applied {converted_count} conversions (Expected: 111)")
assert converted_count == 111, f"Expected 111 conversions, got {converted_count}"

# 5. Write back cleanly using csv.DictWriter
with open(CSV_FILE, "w", encoding="utf-8-sig", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(rows)

print(f"Successfully wrote normalized dataset back to {CSV_FILE}")
