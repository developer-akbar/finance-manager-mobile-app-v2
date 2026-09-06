import csv

with open("finman_2026-09-02.csv", "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

for idx in range(20900, 21200):
    r = rows[idx - 1]
    desc = (r.get("Description") or "").lower()
    note = (r.get("Note") or "").lower()
    tags = (r.get("Tags") or "").lower()
    if "franklin" in f"{desc} {note} {tags}" or "inf090i" in f"{desc} {note} {tags}":
        print(f"Line {idx}: Date={r.get('Date')} | InvType='{r.get('InvestmentTransactionType')}' | Qty={r.get('Quantity')} | Amt={r.get('Amount')} | Note='{r.get('Note')}' | Desc='{r.get('Description')[:50]}'")
