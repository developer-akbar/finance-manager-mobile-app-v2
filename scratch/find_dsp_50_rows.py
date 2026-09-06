import csv

with open("finman_2026-09-02.csv", "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

dsp_txns = []
for idx, r in enumerate(rows, 1):
    note = (r.get("Note") or "").lower()
    desc = (r.get("Description") or "").lower()
    sub = (r.get("SubAccount") or "").lower()
    if "dsp" in (note + desc) and "next" not in (note + desc) and "elss" not in (note + desc) and "groww" not in (note + desc):
        dsp_txns.append((idx, r))

print(f"Total DSP Nifty 50 rows found: {len(dsp_txns)}")
for idx, r in dsp_txns:
    print(f"Line {idx}: Date={r.get('Date')} | Amt={r.get('Amount')} | Sub='{r.get('SubAccount')}' | InvType='{r.get('InvestmentTransactionType')}' | ISIN='{r.get('SecurityISIN')}' | Note='{r.get('Note')}'")
