import csv

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

print(f"Total rows: {len(rows)}")

matched = []
for idx, r in enumerate(rows, 1):
    d = r.get("Date", "").strip()
    if not d.endswith("/2024"):
        continue
    text = " ".join([str(v or "") for v in r.values()]).lower()
    if any(k in text for k in ["etmoney", "et money", "108000", "108001", "56954", "43046", "fd amount", "amrit kalasa", "fareeda groww", "ammi groww", "liquid mutual funds", "father mutual fund"]):
        r["_line"] = idx
        matched.append(r)

def parse_d(d_str):
    parts = d_str.split("/")
    if len(parts) == 3:
        return (int(parts[2]), int(parts[1]), int(parts[0]))
    return (0, 0, 0)

matched.sort(key=lambda r: parse_d(r.get("Date", "")))

print(f"Found {len(matched)} matching rows in 2024:")
for r in matched:
    amt = r.get("Amount") or r.get("INR") or "0"
    print(f"Line {r['_line']:5d} | {r.get('Date'):10s} | {r.get('Income/Expense'):12s} | Rs. {amt:>10s} | From: {r.get('FromAccount') or r.get('Account')} -> To: {r.get('ToAccount')} | Sub: {r.get('SubAccount')} | Note: {r.get('Note')}")
    print(f"       Desc: {r.get('Description')}")
