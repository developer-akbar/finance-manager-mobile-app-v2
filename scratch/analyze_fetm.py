import json

with open("scratch/lmf_audit_rows.json", "r", encoding="utf-8") as f:
    rows = json.load(f)

# Find all rows belonging to Fareeda ETMoney
fetm_rows = []
for r in rows:
    text = f"{r['sub']} {r['to_sub']} {r['from_sub']} {r['brokerage']} {r['note']} {r['desc']}".lower()
    if ("etmoney" in text or "et money" in text) and not ("nippon india liquid" in text or "franklin" in text or "kotak" in text or "ak etmoney" in text):
        fetm_rows.append(r)

print(f"Total Fareeda ETMoney rows: {len(fetm_rows)}")
fetm_rows.sort(key=lambda r: (r['date'].split('/')[::-1]))

total_inflows = 0.0
total_outflows = 0.0
total_pnl = 0.0

for r in fetm_rows:
    amt = float(r['amt'])
    tt = r['type']
    from_a = r['from']
    to_a = r['to']
    note = r['note']
    desc = r['desc']
    if tt == "Transfer-Out":
        if to_a == "Liquid Mutual Funds": total_inflows += amt
        if from_a == "Liquid Mutual Funds": total_outflows += amt
    elif tt == "Income":
        total_pnl += amt
    print(f"Line {r['line']:5d} | Date: {r['date']} | Type: {tt:12s} | Amt: Rs. {amt:>10.2f} | Note: {note[:30]:30s} | Desc: {desc[:40]:40s}")

print(f"\nFareeda ETMoney Inflows:  Rs. {total_inflows:,.2f}")
print(f"Fareeda ETMoney Outflows: Rs. {total_outflows:,.2f}")
print(f"Fareeda ETMoney P&L:      Rs. {total_pnl:,.2f}")
print(f"Net Balance:              Rs. {total_inflows - total_outflows + total_pnl:,.2f}")
