import csv

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

# Let's inspect the 166 transactions that resolved to 'Fareeda Groww'
fg_txns = []
for idx, r in enumerate(rows, 1):
    from_a = (r.get("FromAccount") or r.get("Account") or "").strip()
    to_a = (r.get("ToAccount") or "").strip()
    tt = (r.get("Income/Expense") or "").strip()
    amt_str = r.get("Amount") or r.get("INR") or "0"
    amt = float(amt_str) if amt_str else 0.0
    
    touches = False
    delta = 0.0
    if tt == "Income" and from_a == "Liquid Mutual Funds":
        delta = amt
        touches = True
    elif tt == "Expense" and from_a == "Liquid Mutual Funds":
        delta = -amt
        touches = True
    elif tt == "Transfer-Out":
        if from_a == "Liquid Mutual Funds" and to_a == "Liquid Mutual Funds":
            delta = 0.0
            touches = True
        elif from_a == "Liquid Mutual Funds":
            delta = -amt
            touches = True
        elif to_a == "Liquid Mutual Funds":
            delta = amt
            touches = True
            
    if touches:
        sub = (r.get("SubAccount") or "").strip()
        to_sub = (r.get("ToSubAccount") or "").strip()
        from_sub = (r.get("FromSubAccount") or "").strip()
        brokerage = (r.get("Brokerage") or "").strip()
        note = (r.get("Note") or "").strip().lower()
        desc = (r.get("Description") or "").strip().lower()
        
        explicit = sub or to_sub or from_sub or brokerage
        text = f"{note} {desc}"
        
        # Check if it resolves to Fareeda Groww
        res = ""
        if explicit:
            res = explicit
        elif "ammi" in text:
            res = "Ammi Groww"
        elif "fareeda etmoney" in text or "fareeda et money" in text or "etmoney" in text:
            res = "Fareeda ETMoney"
        else:
            res = "Fareeda Groww"
            
        if res == "Fareeda Groww":
            r["_line"] = idx
            r["_delta"] = delta
            fg_txns.append(r)

print(f"Total txns resolving to Fareeda Groww: {len(fg_txns)}")
total_fg_bal = sum(t["_delta"] for t in fg_txns)
print(f"Total Fareeda Groww Bal: Rs. {total_fg_bal:,.2f}")

# Check which transactions have desc mentioning ETMoney or Ammi or Cashback
etm_in_fg = []
ammi_in_fg = []
pure_fg = []

for t in fg_txns:
    desc = t.get("Description", "").lower()
    note = t.get("Note", "").lower()
    text = f"{note} {desc}"
    if "etmoney" in text or "et money" in text:
        etm_in_fg.append(t)
    elif "ammi" in text or "cashback" in text:
        ammi_in_fg.append(t)
    else:
        pure_fg.append(t)

print(f"Pure Fareeda Groww: {len(pure_fg)} txns, Sum: Rs. {sum(t['_delta'] for t in pure_fg):,.2f}")
print(f"ETMoney in FG:      {len(etm_in_fg)} txns, Sum: Rs. {sum(t['_delta'] for t in etm_in_fg):,.2f}")
print(f"Ammi/Cashback in FG:{len(ammi_in_fg)} txns, Sum: Rs. {sum(t['_delta'] for t in ammi_in_fg):,.2f}")
