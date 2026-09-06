import csv
import json

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

# Let's filter all Liquid Mutual Funds rows as the app currently does
def txn_amt(r):
    return float(r.get("INR") or r.get("Amount") or 0.0)

# 1. Fareeda Groww rows in app
fareeda_groww_txns = []
ammi_groww_txns = []
fareeda_etmoney_txns = []
ak_etmoney_txns = []

for idx, r in enumerate(rows, 1):
    to_acct = (r.get("ToAccount") or "").strip()
    from_acct = (r.get("FromAccount") or r.get("Account") or "").strip()
    cat = (r.get("Category") or "").strip()
    sub = (r.get("SubAccount") or "").strip()
    to_sub = (r.get("ToSubAccount") or "").strip()
    from_sub = (r.get("FromSubAccount") or "").strip()
    brokerage = (r.get("Brokerage") or "").strip()
    note = (r.get("Note") or "").strip()
    desc = (r.get("Description") or "").strip()
    
    text = f"{sub} {to_sub} {from_sub} {brokerage} {note} {desc}".lower()
    
    is_lmf = (to_acct == "Liquid Mutual Funds" or from_acct == "Liquid Mutual Funds" or cat == "Liquid Mutual Funds")
    if not is_lmf:
        continue
        
    r["_line"] = idx
    amt = txn_amt(r)
    tt = r.get("Income/Expense")
    
    # In current app, how does resolveInvestmentSubAccount map it?
    # If desc/note has ammi -> Ammi Groww
    # If desc/note has etmoney -> Fareeda ETMoney
    # Else -> Fareeda Groww
    if "ammi" in text:
        ammi_groww_txns.append(r)
    elif "etmoney" in text or "et money" in text:
        fareeda_etmoney_txns.append(r)
    else:
        fareeda_groww_txns.append(r)

print(f"Fareeda Groww txns count: {len(fareeda_groww_txns)}")
print(f"Ammi Groww txns count:    {len(ammi_groww_txns)}")
print(f"Fareeda ETMoney txns count: {len(fareeda_etmoney_txns)}")

# Compute balances using computeBalance rules
def calc_balance(txns, acct_name="Liquid Mutual Funds"):
    bal = 0.0
    for t in txns:
        amt = txn_amt(t)
        tt = t.get("Income/Expense")
        from_a = t.get("FromAccount") or t.get("Account") or ""
        to_a = t.get("ToAccount") or ""
        if tt == "Income" and from_a == acct_name:
            bal += amt
        elif tt == "Expense" and from_a == acct_name:
            bal -= amt
        elif tt == "Transfer-Out":
            if from_a == acct_name: bal -= amt
            if to_a == acct_name: bal += amt
    return bal

fareeda_groww_bal = calc_balance(fareeda_groww_txns)
ammi_groww_bal = calc_balance(ammi_groww_txns)
fareeda_etmoney_bal = calc_balance(fareeda_etmoney_txns)

print(f"\nCurrent App Balances:")
print(f"  Fareeda Groww:   Rs. {fareeda_groww_bal:,.2f}")
print(f"  Ammi Groww:      Rs. {ammi_groww_bal:,.2f}")
print(f"  Fareeda ETMoney: Rs. {fareeda_etmoney_bal:,.2f}")
print(f"  Total LMF:       Rs. {fareeda_groww_bal + ammi_groww_bal + fareeda_etmoney_bal:,.2f}")

# Now let's analyze Father Mutual Fund in Fareeda Groww and Fareeda ETMoney
father_fg = [t for t in fareeda_groww_txns if "father mutual fund" in (t.get("Note") + " " + t.get("Description")).lower()]
father_fetm = [t for t in fareeda_etmoney_txns if "father mutual fund" in (t.get("Note") + " " + t.get("Description")).lower()]

print(f"\nFather Mutual Fund Rows:")
print(f"  In Fareeda Groww:   {len(father_fg)} rows")
print(f"  In Fareeda ETMoney: {len(father_fetm)} rows")
print(f"  Total Father rows:  {len(father_fg) + len(father_fetm)} rows")

for f in father_fg:
    print(f"    Line {f['_line']:5d} | Date: {f.get('Date')} | Amt: Rs. {txn_amt(f)} | Note: {f.get('Note')} | Desc: {f.get('Description')[:35]}")
for f in father_fetm:
    print(f"    Line {f['_line']:5d} | Date: {f.get('Date')} | Amt: Rs. {txn_amt(f)} | Note: {f.get('Note')} | Desc: {f.get('Description')[:35]}")
