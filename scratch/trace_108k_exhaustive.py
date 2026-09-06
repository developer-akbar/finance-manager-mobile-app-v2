import csv
import json

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

def parse_d(d_str):
    parts = d_str.split("/")
    if len(parts) == 3:
        return (int(parts[2]), int(parts[1]), int(parts[0]))
    return (0, 0, 0)

# Check all transactions around 27/04/2024
txns_around_maturity = []
for idx, r in enumerate(rows, 1):
    d = r.get("Date", "").strip()
    p = parse_d(d)
    if (2024, 4, 20) <= p <= (2024, 5, 5):
        r["_line"] = idx
        txns_around_maturity.append(r)

print(f"Transactions around maturity date (20-Apr-2024 to 05-May-2024): {len(txns_around_maturity)}")
for t in txns_around_maturity:
    amt = t.get("Amount") or t.get("INR")
    from_a = t.get("FromAccount") or t.get("Account")
    to_a = t.get("ToAccount")
    desc = t.get("Description") or ""
    note = t.get("Note") or ""
    if any(k in f"{amt} {from_a} {to_a} {desc} {note}".lower() for k in ["sbi", "rd", "fd", "108", "100000", "maturity", "fareeda", "digi", "kalas"]):
        print(f"  Line {t['_line']:5d} | {t.get('Date')} | {t.get('Income/Expense')} | Rs. {amt} | From: {from_a} -> To: {to_a} | Note: {note} | Desc: {desc[:40]}")

