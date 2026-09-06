import csv

with open("finman_2026-09-02.csv", "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

for idx, r in enumerate(rows, 1):
    note = (r.get("Note") or "").lower()
    desc = (r.get("Description") or "").lower()
    isin = (r.get("SecurityISIN") or "").lower()
    tags = (r.get("Tags") or "").lower()
    combined = f"{note} {desc} {isin} {tags}"
    if "franklin" in combined or "inf090i" in combined or "6994" in combined:
        print(f"Line {idx}: Date={r.get('Date')} | Amt={r.get('Amount')} | InvType='{r.get('InvestmentTransactionType')}' | Qty={r.get('Quantity')} | Note='{r.get('Note')}' | Desc='{r.get('Description')[:50]}' | Tags='{r.get('Tags')}'")
