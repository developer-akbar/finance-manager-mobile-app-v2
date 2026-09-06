import csv

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    reader = csv.DictReader(f)
    fieldnames = reader.fieldnames
    rows = list(reader)

print("CSV Headers:")
print(fieldnames)

# Find sample first-class BUY rows from Tax Saver and Share Market
sample_buys = []
for idx, r in enumerate(rows, 1):
    inv_type = (r.get("InvestmentTransactionType") or "").strip()
    if inv_type == "BUY":
        r["_line"] = idx
        sample_buys.append(r)
        if len(sample_buys) >= 3:
            break

print("\nSample first-class BUY rows:")
for s in sample_buys:
    print(f"\n--- Line {s['_line']} ---")
    for k, v in s.items():
        if v:
            print(f"  {k}: {v}")
