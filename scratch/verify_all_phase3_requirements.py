import csv
import json

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

# Verify the 16 critical historical records
checklist = {
    "12110": "SBI RD AK Personal (Rs. 56,954)",
    "12411": "Fahim memo (Rs. 43,046 memo)",
    "8529": "FD interest memo (Rs. 8,000 memo)",
    "7931": "FD interest deployment memo (Rs. 8,000 memo)",
    "8157": "Motilal Large & Midcap FD memo (Rs. 30,000 memo)",
    "8158": "DSP Next 50 FD memo (Rs. 30,000 memo)",
    "7894": "Quant Ammi FD memo (Rs. 40,000 memo)",
    "7247": "Quant manual switch memo (Rs. 0)",
    "6404": "DSP Next 50 ETMoney real reinvestment (Rs. 50,000)",
    "6405": "Motilal Midcap ETMoney real reinvestment (Rs. 50,000)",
    "6577": "DSP Next 50 FD redemption loss (Rs. -1,147)",
    "6578": "DSP Next 50 FD redemption proceeds (Rs. 28,859)",
    "6579": "Motilal Large & Midcap FD redemption gain (Rs. 3,457)",
    "6580": "Motilal Large & Midcap FD redemption proceeds (Rs. 41,457)",
    "6581": "DSP Nifty 50 redemption loss (Rs. -9,262)",
    "6582": "DSP Nifty 50 redemption proceeds (Rs. 288,738)",
    "7534": "Ammi cashback 1 (Rs. 6,937)",
    "7426": "Ammi cashback 2 (Rs. 2,228)",
    "6906": "Ammi cashback 3 (Rs. 1,922)",
    "6427": "Ammi cashback 4 (Rs. 3,338)",
    "6125": "Ammi cashback 5 (Rs. 2,144)",
    "4901": "Ammi cashback 6 (Rs. 11,801)",
    "4232": "Ammi cashback 7 (Rs. 7,630)",
}

print("=== CHECKING ALL CRITICAL HISTORICAL RECORDS ===")
for line_str, desc in checklist.items():
    idx = int(line_str) - 1
    r = rows[idx]
    amt = r.get("Amount") or r.get("INR")
    sub = r.get("SubAccount") or ""
    to_sub = r.get("ToSubAccount") or ""
    from_sub = r.get("FromSubAccount") or ""
    print(f"Line {line_str:>5s} | Amt: Rs. {float(amt):>9.2f} | Sub: '{sub:<15}' | ToSub: '{to_sub:<15}' | FromSub: '{from_sub:<15}' | {desc}")
