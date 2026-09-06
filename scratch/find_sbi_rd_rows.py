import csv

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

# Search for all rows mentioning SBI RD
sbi_rd_rows = []
for idx, r in enumerate(rows, 1):
    from_acct = str(r.get("FromAccount") or r.get("Account") or "")
    to_acct = str(r.get("ToAccount") or "")
    cat = str(r.get("Category") or "")
    text = " ".join([str(v or "") for v in r.values()]).lower()
    if "sbi rd" in f"{from_acct} {to_acct} {cat}".lower() or "amrit kalasa" in text:
        r["_line"] = idx
        sbi_rd_rows.append(r)

print(f"Total SBI RD rows found: {len(sbi_rd_rows)}")
for r in sbi_rd_rows:
    amt = r.get("Amount") or r.get("INR") or "0"
    print(f"Line {r['_line']:5d} | {r.get('Date'):10s} | {r.get('Income/Expense'):12s} | Rs. {amt:>10s} | From: {r.get('FromAccount') or r.get('Account')} -> To: {r.get('ToAccount')} | Cat: {r.get('Category')} | Note: {r.get('Note')}")
    print(f"       Desc: {r.get('Description')}")
