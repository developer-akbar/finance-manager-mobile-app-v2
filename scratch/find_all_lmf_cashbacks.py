import csv

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

lmf_cb_rows = []
for idx, r in enumerate(rows, 1):
    to_a = (r.get("ToAccount") or "").strip()
    from_a = (r.get("FromAccount") or r.get("Account") or "").strip()
    cat = (r.get("Category") or "").strip()
    note = (r.get("Note") or "").strip()
    desc = (r.get("Description") or "").strip()
    amt = float(r.get("Amount") or r.get("INR") or 0)
    
    is_lmf = to_a == "Liquid Mutual Funds" or from_a == "Liquid Mutual Funds" or cat == "Liquid Mutual Funds"
    if is_lmf and ("cashback" in f"{note} {desc}".lower()):
        r["_line"] = idx
        lmf_cb_rows.append(r)

print(f"Total Liquid MF rows mentioning cashback: {len(lmf_cb_rows)}")
for r in lmf_cb_rows:
    amt = float(r.get("Amount") or r.get("INR") or 0)
    print(f"Line {r['_line']:5d} | Date: {r.get('Date')} | Amt: Rs. {amt:>8.2f} | From: {r.get('FromAccount') or r.get('Account')} -> To: {r.get('ToAccount')} | Sub: '{r.get('SubAccount')}' | Note: {r.get('Note')} | Desc: {r.get('Description').replace(chr(10), ' ')[:45]}")
