import csv

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

dsp_nifty_rows = []
for idx, r in enumerate(rows, 1):
    note = (r.get("Note") or "").strip()
    desc = (r.get("Description") or "").strip()
    sub = (r.get("SubAccount") or "").strip()
    to_sub = (r.get("ToSubAccount") or "").strip()
    from_sub = (r.get("FromSubAccount") or "").strip()
    amt = float(r.get("Amount") or r.get("INR") or 0)
    to_a = r.get("ToAccount") or ""
    from_a = r.get("FromAccount") or r.get("Account") or ""
    
    if "dsp nifty" in f"{note} {desc}".lower() and (to_a == "Liquid Mutual Funds" or from_a == "Liquid Mutual Funds"):
        dsp_nifty_rows.append((idx, r.get("Date"), amt, r.get("Income/Expense"), from_a, to_a, sub, from_sub, to_sub, desc[:40]))

print(f"Total DSP Nifty rows: {len(dsp_nifty_rows)}")
for dr in dsp_nifty_rows:
    print(f"Row {dr[0]:5d} | Date: {dr[1]} | Amt: Rs. {dr[2]:>9.2f} | Type: {dr[3]:12s} | From: {dr[4]} -> To: {dr[5]} | Sub: '{dr[6]}' | FromSub: '{dr[7]}' | ToSub: '{dr[8]}'")
