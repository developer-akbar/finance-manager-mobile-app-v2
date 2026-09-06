import csv

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

# Trace all transactions currently resolving to Ammi Groww
ammi_txns = []
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
        
        # Current resolution logic:
        res = ""
        if explicit:
            res = explicit
        elif "ammi" in text:
            res = "Ammi Groww"
        elif "fareeda etmoney" in text or "fareeda et money" in text or "etmoney" in text:
            res = "Fareeda ETMoney"
        else:
            res = "Fareeda Groww"
            
        if res == "Ammi Groww":
            r["_line"] = idx
            r["_delta"] = delta
            ammi_txns.append(r)

print(f"Total transactions currently in Ammi Groww: {len(ammi_txns)}")
print(f"Current Ammi Groww Balance: Rs. {sum(t['_delta'] for t in ammi_txns):,.2f}")

print("\n--- ALL TRANSACTIONS CURRENTLY IN AMMI GROWW ---")
for t in ammi_txns:
    print(f"Line {t['_line']:5d} | Date: {t.get('Date')} | Delta: {t['_delta']:>10.2f} | Note: {t.get('Note')[:25]:25s} | Desc: {t.get('Description')[:35]}")
