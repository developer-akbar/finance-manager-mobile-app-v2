import csv

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

print(f"Loaded {len(rows)} rows from {CSV_FILE}")

# Check specific dates and amounts
dates_to_check = ["24/03/2023", "27/04/2024", "12/06/2024", "05/07/2024", "14/11/2024", "28/11/2024"]
amounts_to_check = ["56954", "43046", "108000", "100000", "8000", "30000", "50000", "600"]

matched_date_rows = []
for idx, r in enumerate(rows, start=1):
    d = r.get("Date", "").strip()
    amt = str(r.get("Amount") or r.get("INR") or "").strip()
    amt_f = float(amt) if amt else 0.0
    text = " ".join([str(v or "") for v in r.values()]).lower()
    
    match_date = d in dates_to_check
    match_amt = any(abs(amt_f - float(a)) < 0.01 for a in ["56954", "43046", "108000", "100000", "8000"])
    match_kw = any(k in text for k in ["fareeda etmoney", "fareeda et money", "fd amount", "fahim", "sbi rd", "motilal", "dsp nifty"])
    
    if (match_date and match_kw) or match_amt or ("108000" in text or "56954" in text or "43046" in text):
        r["_line"] = idx
        matched_date_rows.append(r)

print(f"Found {len(matched_date_rows)} target rows.")
for r in matched_date_rows:
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
    print(f"\nLine {r['_line']} | ID: {r.get('ID')} | Date: {date} | Type: {tt} | Amt: Rs. {amt}")
    print(f"   From: {from_acct} (sub: {from_sub}) -> To: {to_acct} (sub: {to_sub}) | Sub: {sub} | Cat: {cat}")
    print(f"   InvType: {inv_type} | Sec: {r.get('SecuritySymbol')}")
    print(f"   Note: {note}")
    print(f"   Desc: {desc}")
