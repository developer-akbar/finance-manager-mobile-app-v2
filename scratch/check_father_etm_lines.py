import csv

with open("finman_2026-09-02.csv", "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

father_lines = [6406, 6249, 5848, 5617, 5271, 5043]
for l in father_lines:
    r = rows[l - 1]
    print(f"Line {l}: Date={r.get('Date')} | Amt={r.get('Amount')} | Note='{r.get('Note')}' | Sub='{r.get('SubAccount')}' | ToSub='{r.get('ToSubAccount')}' | Desc='{r.get('Description')}'")
