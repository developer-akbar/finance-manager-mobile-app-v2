import csv
import json

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

# Let's verify:
# 1. Fareeda Groww: Rs. 315,000 gross vs Rs. 314,984 net
# 2. Fareeda ETMoney: Rs. 31,994
# 3. Ammi Groww: Rs. 197,915
# 4. Ammi Cashback: Rs. 21,575
# Total: 315,000 + 197,915 + 31,994 + 21,575 = 566,484

print("315000 + 197915 + 31994 + 21575 =", 315000 + 197915 + 31994 + 21575)
print("Difference to 566484 =", (315000 + 197915 + 31994 + 21575) - 566484)

# Let's inspect the exact stamp duty across the Pure Fareeda Groww txns
pure_fg_txns = []
for idx, r in enumerate(rows, 1):
    to_a = (r.get("ToAccount") or "").strip()
    from_a = (r.get("FromAccount") or r.get("Account") or "").strip()
    note = (r.get("Note") or "").strip()
    desc = (r.get("Description") or "").strip()
    amt = float(r.get("Amount") or r.get("INR") or 0.0)
    text = f"{note} {desc}".lower()
    
    if to_a == "Liquid Mutual Funds" and not any(k in text for k in ["ammi", "cashback", "etmoney", "et money", "father mutual fund"]):
        pure_fg_txns.append(amt)

print(f"Total pure Fareeda Groww inflows count: {len(pure_fg_txns)}")
print(f"Sum of pure Fareeda Groww gross inflows: Rs. {sum(pure_fg_txns):,.2f}")
