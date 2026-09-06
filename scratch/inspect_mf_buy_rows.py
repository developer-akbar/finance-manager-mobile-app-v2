import csv

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

mf_buys = []
for idx, r in enumerate(rows, 1):
    inv_type = (r.get("InvestmentTransactionType") or "").strip()
    to_a = (r.get("ToAccount") or "").strip()
    from_a = (r.get("FromAccount") or "").strip()
    if inv_type == "BUY" and ("Mutual" in to_a or "Mutual" in from_a):
        r["_line"] = idx
        mf_buys.append(r)
        if len(mf_buys) >= 3:
            break

print(f"Sample MF BUY rows: {len(mf_buys)}")
for s in mf_buys:
    print(f"\n--- Line {s['_line']} ---")
    for k, v in s.items():
        if v:
            print(f"  {k}: {v}")
