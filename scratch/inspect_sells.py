import csv

with open("finman_2026-09-02.csv", "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

sells = []
for idx, r in enumerate(rows, 1):
    inv_type = (r.get("InvestmentTransactionType") or "").strip()
    if inv_type == "SELL" or "redemption" in (r.get("Note") or "").lower() or "redemption" in (r.get("Description") or "").lower():
        sells.append((idx, r))

print(f"Total potential SELL / redemption rows: {len(sells)}")
for idx, r in sells[:20]:
    print(f"Line {idx}: Date={r.get('Date')} | InvType='{r.get('InvestmentTransactionType')}' | From='{r.get('FromAccount')}' | To='{r.get('ToAccount')}' | Sub='{r.get('SubAccount')}' | Amt={r.get('Amount')} | Qty={r.get('Quantity')} | CostBasis={r.get('CostBasis')} | Note='{r.get('Note')[:30]}'")
