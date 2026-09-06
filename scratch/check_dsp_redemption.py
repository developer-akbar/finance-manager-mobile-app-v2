import csv

with open("finman_2026-09-02.csv", "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

for idx, r in enumerate(rows, 1):
    dt = r.get("Date")
    if dt in ["14/11/2024", "15/11/2024"]:
        amt = float(r.get("Amount") or 0)
        note = r.get("Note") or ""
        desc = r.get("Description") or ""
        sub = r.get("SubAccount") or ""
        if amt > 10000 or "dsp" in (note + desc).lower() or "redemption" in (note + desc).lower():
            print(f"Line {idx}: Date={dt} | Amt={amt} | Type={r.get('Income/Expense')} | InvType='{r.get('InvestmentTransactionType')}' | From={r.get('FromAccount')} | To={r.get('ToAccount')} | Sub={sub} | Note='{note}' | Desc='{desc[:50]}'")
