import csv

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

# Ammi CAS active holdings transactions:
# 1. 30/05/2024 Rs. 500 Motilal Oswal Midcap
# 2. 19/08/2024 Rs. 50000 Motilal Oswal Large and Midcap
# 3. 21/08/2024 Rs. 6937 Motilal Oswal Midcap
# 4. 02/09/2024 Rs. 2228 Motilal Oswal Midcap
# 5. 23/09/2024 Rs. 50000 Motilal Oswal Large and Midcap
# 6. 14/10/2024 Rs. 1922 Motilal Oswal Midcap
# 7. 25/11/2024 Rs. 3338 Motilal Oswal Midcap
# 8. 25/11/2024 Rs. 50000 Motilal Oswal Large and Midcap
# 9. 25/11/2024 Rs. 30000 Nippon India Large Cap
# 10. 03/01/2025 Rs. 2144 Motilal Oswal Midcap
# 11. 17/02/2025 Rs. 43000 Parag Parikh Flexi Cap
# 12. 28/04/2025 Rs. 11801 Motilal Oswal Midcap
# 13. 19/06/2025 Rs. 7630 Motilal Oswal Midcap

cas_items = [
    ("30/05/2024", 500.0, "Motilal Oswal Midcap"),
    ("19/08/2024", 50000.0, "Motilal Oswal Large and Midcap"),
    ("21/08/2024", 6937.0, "Motilal Oswal Midcap"),
    ("02/09/2024", 2228.0, "Motilal Oswal Midcap"),
    ("23/09/2024", 50000.0, "Motilal Oswal Large and Midcap"),
    ("14/10/2024", 1922.0, "Motilal Oswal Midcap"),
    ("25/11/2024", 3338.0, "Motilal Oswal Midcap"),
    ("25/11/2024", 50000.0, "Motilal Oswal Large and Midcap"),
    ("25/11/2024", 30000.0, "Nippon India Large Cap"),
    ("03/01/2025", 2144.0, "Motilal Oswal Midcap"),
    ("17/02/2025", 43000.0, "Parag Parikh flexi cap"),
    ("28/04/2025", 11801.0, "Motilal Oswal Midcap"),
    ("19/06/2025", 7630.0, "Motilal Oswal Midcap")
]

print("=== CHECKING EACH AMMI CAS TRANSACTION IN FINMAN CSV ===")
for date, amt, fund in cas_items:
    # Find matching row in CSV
    matched_rows = []
    for idx, r in enumerate(rows, 1):
        d = r.get("Date", "").strip()
        amt_str = r.get("Amount") or r.get("INR") or "0"
        a = float(amt_str) if amt_str else 0.0
        if d == date and abs(a - amt) < 1.0:
            r["_line"] = idx
            matched_rows.append(r)
    print(f"\nCAS: {date} | Rs. {amt:8.2f} | {fund}")
    if matched_rows:
        for m in matched_rows:
            print(f"   -> FOUND Line {m['_line']}: Date {m.get('Date')}, Rs. {m.get('Amount')}, From: {m.get('FromAccount') or m.get('Account')} -> To: {m.get('ToAccount')}, Sub: '{m.get('SubAccount')}', Note: {m.get('Note')}, Desc: {m.get('Description')[:30]}")
    else:
        print(f"   -> NOT FOUND!")
