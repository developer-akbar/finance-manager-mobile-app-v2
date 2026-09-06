import csv

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

# Search for "switch" in Note or Description for Liquid Mutual Funds rows
switch_rows = []
for idx, r in enumerate(rows, 1):
    note = (r.get("Note") or "").strip()
    desc = (r.get("Description") or "").strip()
    sub = (r.get("SubAccount") or "").strip()
    from_a = (r.get("FromAccount") or r.get("Account") or "").strip()
    to_a = (r.get("ToAccount") or "").strip()
    cat = (r.get("Category") or "").strip()
    
    text = f"{note} {desc}".lower()
    is_lmf = ("liquid" in f"{from_a} {to_a} {cat}".lower()) or any(k in text for k in ["fareeda", "ammi", "groww", "etmoney"])
    
    if "switch" in text:
        r["_line"] = idx
        r["_is_lmf"] = is_lmf
        switch_rows.append(r)

print(f"Total rows in CSV mentioning 'switch': {len(switch_rows)}")
lmf_switches = [r for r in switch_rows if r["_is_lmf"]]
print(f"Liquid MF rows mentioning 'switch': {len(lmf_switches)}")

for s in lmf_switches:
    amt = s.get("Amount") or s.get("INR")
    print(f"\nLine {s['_line']:5d} | Date: {s.get('Date')} | Type: {s.get('Income/Expense')} | Amt: Rs. {amt}")
    print(f"   From: {s.get('FromAccount') or s.get('Account')} -> To: {s.get('ToAccount')} | Sub: {s.get('SubAccount')}")
    print(f"   Note: {s.get('Note')}")
    print(f"   Desc: {s.get('Description')}")
