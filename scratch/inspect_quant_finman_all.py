import csv

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

quant_rows = []
for idx, r in enumerate(rows, 1):
    note = str(r.get("Note") or "").strip()
    desc = str(r.get("Description") or "").strip()
    sub = str(r.get("SubAccount") or "").strip()
    from_a = str(r.get("FromAccount") or r.get("Account") or "").strip()
    to_a = str(r.get("ToAccount") or "").strip()
    cat = str(r.get("Category") or "").strip()
    
    text = f"{note} {desc} {sub} {cat}".lower()
    is_lmf = "liquid" in f"{from_a} {to_a} {cat}".lower()
    
    if "quant" in text and is_lmf:
        r["_line"] = idx
        quant_rows.append(r)

print(f"Total Quant rows in Liquid Mutual Funds: {len(quant_rows)}")
quant_rows.sort(key=lambda r: (r.get("Date", "").split("/")[::-1]))

for r in quant_rows:
    amt = r.get("Amount") or r.get("INR") or "0"
    print(f"\nLine {r['_line']:5d} | Date: {r.get('Date')} | Type: {r.get('Income/Expense'):12s} | Amt: Rs. {amt:>10s}")
    print(f"   From: {r.get('FromAccount') or r.get('Account')} -> To: {r.get('ToAccount')} | Sub: '{r.get('SubAccount')}' | Note: {r.get('Note')}")
    print(f"   Desc: {r.get('Description')}")
