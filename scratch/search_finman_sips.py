import csv

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

print(f"Total rows: {len(rows)}")

# Search for DSP Nifty Next 50 in FinMan
dsp_next50_txns = []
for idx, r in enumerate(rows, 1):
    to_a = (r.get("ToAccount") or "").strip()
    from_a = (r.get("FromAccount") or r.get("Account") or "").strip()
    note = (r.get("Note") or "").strip()
    desc = (r.get("Description") or "").strip()
    sub = (r.get("SubAccount") or "").strip()
    to_sub = (r.get("ToSubAccount") or "").strip()
    amt = float(r.get("Amount") or r.get("INR") or 0)
    
    text = f"{note} {desc}".lower()
    if ("dsp" in text and "next" in text) or ("dsp nifty next 50" in text):
        r["_line"] = idx
        dsp_next50_txns.append(r)

print(f"Total DSP Nifty Next 50 transactions in FinMan: {len(dsp_next50_txns)}")
total_amt = 0
for r in dsp_next50_txns:
    amt = float(r.get("Amount") or 0)
    total_amt += amt
    print(f"Line {r['_line']:5d} | Date: {r.get('Date')} | Amt: Rs. {amt:>8.2f} | Note: {r.get('Note'):<25} | Sub: '{r.get('SubAccount')}' | ToSub: '{r.get('ToSubAccount')}' | Desc: {r.get('Description')[:40]}")

print(f"Total Amount: Rs. {total_amt:,.2f}")
