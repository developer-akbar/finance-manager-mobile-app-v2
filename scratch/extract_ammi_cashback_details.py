import csv

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

cb_lines = [7534, 7426, 6906, 6427, 6125, 4901, 4232]

print("=== AMMI CASHBACK TRANSACTIONS IN FINMAN ===")
for l in cb_lines:
    r = rows[l - 1]
    id_val = r.get("ID")
    date = r.get("Date")
    amt = float(r.get("Amount") or r.get("INR") or 0)
    from_a = r.get("FromAccount") or r.get("Account")
    to_a = r.get("ToAccount")
    sub = r.get("SubAccount")
    note = r.get("Note")
    desc = r.get("Description").replace("\n", " ")
    tt = r.get("Income/Expense")
    print(f"Line {l:5d} | Date: {date} | ID: {id_val} | Amt: Rs. {amt:>8.2f} | From: {from_a} -> To: {to_a} | Sub: '{sub}' | Type: {tt} | Note: {note} | Desc: {desc[:50]}")
