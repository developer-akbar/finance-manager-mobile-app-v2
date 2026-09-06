import csv

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

# Check Liquid Mutual Funds rows
lmf_rows = []
for idx, r in enumerate(rows, 1):
    to_a = (r.get("ToAccount") or "").strip()
    from_a = (r.get("FromAccount") or r.get("Account") or "").strip()
    inv_a = (r.get("InvestmentAccount") or "").strip()
    sub = (r.get("SubAccount") or "").strip()
    
    if to_a == "Liquid Mutual Funds" or from_a == "Liquid Mutual Funds" or inv_a == "Liquid Mutual Funds" or sub in ["Fareeda Groww", "Fareeda ETMoney", "Ammi Groww"]:
        r["_line"] = idx
        lmf_rows.append(r)

print(f"Total Liquid MF / SubAccount rows: {len(lmf_rows)}")

has_inv_type = 0
has_qty = 0
has_isin = 0
has_price = 0
for r in lmf_rows:
    if r.get("InvestmentTransactionType"): has_inv_type += 1
    if r.get("Quantity"): has_qty += 1
    if r.get("SecurityISIN") or r.get("ISIN"): has_isin += 1
    if r.get("UnitPrice") or r.get("NAV"): has_price += 1

print(f"Rows with InvestmentTransactionType: {has_inv_type}")
print(f"Rows with Quantity: {has_qty}")
print(f"Rows with ISIN: {has_isin}")
print(f"Rows with UnitPrice/NAV: {has_price}")

# Check by SubAccount:
sub_counts = {}
for r in lmf_rows:
    sub = r.get("SubAccount") or "(empty)"
    inv_type = r.get("InvestmentTransactionType") or "(none)"
    sub_counts[(sub, inv_type)] = sub_counts.get((sub, inv_type), 0) + 1

print("\nSubAccount breakdown (SubAccount, InvType):")
for k, v in sorted(sub_counts.items()):
    print(f"  {k[0]:<20} | {k[1]:<10} : {v} rows")
