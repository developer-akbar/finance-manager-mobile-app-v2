import csv

with open("finman_2026-09-02.csv", "r", encoding="utf-8-sig") as f:
    r = csv.reader(f)
    headers = next(r)

print("Headers count:", len(headers))
for h in ["FolioNumber", "HoldingMode", "OwnershipTag", "Tags", "Brokerage", "SecurityISIN", "SecuritySymbol", "Quantity", "UnitPrice"]:
    print(f"  {h}: {'PRESENT' if h in headers else 'NOT in CSV'}")
