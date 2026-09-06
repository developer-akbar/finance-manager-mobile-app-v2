import csv

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

target_lines = [12411, 12110, 8529, 8157, 8158, 7931, 7894, 6577, 6578, 6579, 6580, 6581, 6582, 6404, 6405]

print("=== 108K CHRONOLOGICAL TRAIL ROWS ===")
for l in target_lines:
    r = rows[l - 1]
    id_val = r.get("ID")
    date = r.get("Date")
    tt = r.get("Income/Expense")
    amt = float(r.get("Amount") or r.get("INR") or 0)
    from_a = r.get("FromAccount") or r.get("Account")
    to_a = r.get("ToAccount")
    sub = r.get("SubAccount")
    note = r.get("Note")
    desc = r.get("Description").replace("\n", " ")
    print(f"{date} | {l:5d} | {id_val} | {tt:12s} | Rs. {amt:>9.2f} | From: {from_a} -> To: {to_a} | Sub: '{sub}' | Note: {note} | Desc: {desc[:60]}")
