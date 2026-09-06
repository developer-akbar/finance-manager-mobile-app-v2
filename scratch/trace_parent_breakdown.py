import csv
import json

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

# Let's inspect the 242 transactions touching Liquid Mutual Funds
acct_name = "Liquid Mutual Funds"

txns_by_raw_sub = {}
txns_by_resolved_sub = {}

# Replicate resolveInvestmentSubAccount exactly as in brokerageAccounting.js
def resolve_subaccount(r):
    sub = (r.get("SubAccount") or "").strip()
    to_sub = (r.get("ToSubAccount") or "").strip()
    from_sub = (r.get("FromSubAccount") or "").strip()
    brokerage = (r.get("Brokerage") or "").strip()
    note = (r.get("Note") or "").strip().lower()
    desc = (r.get("Description") or "").strip().lower()
    
    explicit = sub or to_sub or from_sub or brokerage
    if explicit:
        return explicit
        
    text = f"{note} {desc}"
    if "ammi" in text:
        return "Ammi Groww"
    if "fareeda etmoney" in text or "fareeda et money" in text or "etmoney" in text:
        return "Fareeda ETMoney"
    if "groww" in text or "fareeda" in text:
        return "Fareeda Groww"
        
    return "(Unassigned / None)"

delta_by_resolved = {}
txns_by_resolved = {}

for idx, r in enumerate(rows, 1):
    from_a = (r.get("FromAccount") or r.get("Account") or "").strip()
    to_a = (r.get("ToAccount") or "").strip()
    tt = (r.get("Income/Expense") or "").strip()
    amt_str = r.get("Amount") or r.get("INR") or "0"
    amt = float(amt_str) if amt_str else 0.0
    
    touches = False
    delta = 0.0
    if tt == "Income" and from_a == acct_name:
        delta = amt
        touches = True
    elif tt == "Expense" and from_a == acct_name:
        delta = -amt
        touches = True
    elif tt == "Transfer-Out":
        if from_a == acct_name and to_a == acct_name:
            delta = 0.0
            touches = True
        elif from_a == acct_name:
            delta = -amt
            touches = True
        elif to_a == acct_name:
            delta = amt
            touches = True
            
    if touches:
        r["_line"] = idx
        r["_delta"] = delta
        sub_res = resolve_subaccount(r)
        delta_by_resolved[sub_res] = delta_by_resolved.get(sub_res, 0.0) + delta
        if sub_res not in txns_by_resolved:
            txns_by_resolved[sub_res] = []
        txns_by_resolved[sub_res].append(r)

print("=== BREAKDOWN OF THE Rs. 566,484 PARENT BALANCE BY RESOLVED SUBACCOUNT ===")
total_sum = 0.0
for sub, d in sorted(delta_by_resolved.items()):
    cnt = len(txns_by_resolved[sub])
    total_sum += d
    print(f"  {sub:25s}: Rs. {d:>12,.2f}  ({cnt} txns)")

print(f"  ------------------------------------------------")
print(f"  TOTAL PARENT BALANCE     : Rs. {total_sum:>12,.2f}")

print("\nTransactions in '(Unassigned / None)':")
for t in txns_by_resolved.get("(Unassigned / None)", []):
    print(f"  Line {t['_line']:5d} | Date: {t.get('Date')} | Delta: {t['_delta']:>10.2f} | Note: {t.get('Note')} | Desc: {t.get('Description')[:40]}")
