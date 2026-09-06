import csv
import json

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

print(f"Total rows in CSV: {len(rows)}")

# 1. Investigate the 7 Cashback transactions
cashback_amounts = [6937.0, 2228.0, 1922.0, 3338.0, 2144.0, 11801.0, 7630.0]
print("Sum of user's 7 cashback amounts:", sum(cashback_amounts))

found_cashback = []
for idx, r in enumerate(rows, 1):
    amt_str = r.get("Amount") or r.get("INR") or "0"
    amt = float(amt_str) if amt_str else 0.0
    for ca in cashback_amounts:
        if abs(amt - ca) < 0.01 and "motilal" in (r.get("Note", "") + " " + r.get("Description", "")).lower():
            r["_line"] = idx
            found_cashback.append(r)
            break

print(f"\nFound {len(found_cashback)} matching cashback rows:")
for cb in found_cashback:
    print(f"Line {cb['_line']:5d} | Date: {cb.get('Date')} | Amt: Rs. {float(cb.get('Amount') or 0):>8.2f} | From: {cb.get('FromAccount') or cb.get('Account')} -> To: {cb.get('ToAccount')} | Sub: '{cb.get('SubAccount')}' | Note: {cb.get('Note')} | Desc: {cb.get('Description')[:45]}")

