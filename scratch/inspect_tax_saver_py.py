import csv

with open("finman_2026-09-02.csv", "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

ts_txns = []
for idx, r in enumerate(rows, start=2):
    fa = r.get("FromAccount", "") or r.get("Account", "")
    ta = r.get("ToAccount", "")
    ac = r.get("Account", "")
    if "Tax Saver" in fa or "Tax Saver" in ta or "Tax Saver" in ac:
        r["_line"] = idx
        ts_txns.append(r)

print(f"Total Tax Saver rows: {len(ts_txns)}")
inflows = 0
outflows = 0
for r in ts_txns:
    fa = r.get("FromAccount", "") or r.get("Account", "")
    ta = r.get("ToAccount", "")
    ac = r.get("Account", "")
    amt = float(r.get("Amount") or r.get("INR") or 0)
    t = r.get("Income/Expense", "")
    if t == "Transfer-Out":
        if ta == "Mutual Funds Tax Saver":
            inflows += amt
        if fa == "Mutual Funds Tax Saver":
            outflows += amt

print(f"Inflows: {inflows}, Outflows: {outflows}, Net: {inflows - outflows}")

# Let's see outflows:
print("\nOutflows from Mutual Funds Tax Saver:")
for r in ts_txns:
    fa = r.get("FromAccount", "") or r.get("Account", "")
    amt = float(r.get("Amount") or r.get("INR") or 0)
    t = r.get("Income/Expense", "")
    if t == "Transfer-Out" and fa == "Mutual Funds Tax Saver":
        print(f"Line {r['_line']} | Date: {r.get('Date')} | To: {r.get('ToAccount')} | Amt: {amt} | InvType: {r.get('InvestmentTransactionType')} | Note: {r.get('Note')}")
