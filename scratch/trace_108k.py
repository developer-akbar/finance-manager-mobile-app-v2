import csv
import json

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

# Search for 108000, 100000, 56954, 43046, 8000, Fahim, SBI RD, Post Office, FD / RD
target_terms = ["108000", "56954", "43046", "fahim", "sbi rd", "post office", "100000", "fd amount", "etmoney", "et money"]

fd_rd_rows = []
for idx, r in enumerate(rows, start=1):
    text = " ".join([str(v or "") for v in r.values()]).lower()
    for term in target_terms:
        if term in text:
            r["_line"] = idx
            r["_matched"] = term
            fd_rd_rows.append(r)
            break

print(f"Found {len(fd_rd_rows)} rows matching FD/RD / Fahim / 108k / 56954 / 43046 / ETMoney terms")

for r in fd_rd_rows:
    amt = r.get("Amount") or r.get("INR")
    note = r.get("Note") or ""
    desc = r.get("Description") or ""
    date = r.get("Date") or ""
    from_acct = r.get("FromAccount") or r.get("Account") or ""
    to_acct = r.get("ToAccount") or ""
    sub = r.get("SubAccount") or ""
    to_sub = r.get("ToSubAccount") or ""
    from_sub = r.get("FromSubAccount") or ""
    cat = r.get("Category") or ""
    tt = r.get("Income/Expense") or ""
    inv_type = r.get("InvestmentTransactionType") or ""
    
    # Filter for relevant amounts or notes
    if any(k in f"{amt} {note} {desc}".lower() for k in ["56954", "43046", "108000", "100000", "8000", "fahim", "rd", "etmoney", "motilal", "dsp"]):
        print(f"\nLine {r['_line']} | ID: {r.get('ID')} | Date: {date} | Type: {tt} | Amt: Rs. {amt}")
        print(f"   From: {from_acct} (sub: {from_sub}) -> To: {to_acct} (sub: {to_sub}) | Sub: {sub} | Cat: {cat}")
        print(f"   InvType: {inv_type} | Sec: {r.get('SecuritySymbol')}")
        print(f"   Note: {note}")
        print(f"   Desc: {desc}")
