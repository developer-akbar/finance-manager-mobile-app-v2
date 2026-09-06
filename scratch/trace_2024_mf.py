import csv

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

print(f"Total rows: {len(rows)}")

# Filter for 2024 rows relevant to Fareeda / Ammi / Liquid MF / FD / RD / 108000
results = []
for idx, r in enumerate(rows, start=1):
    d = r.get("Date", "").strip()
    # Check if in 2024 or 2025
    if not (d.endswith("/2024") or d.endswith("/2023") or d.endswith("/2025")):
        continue
    
    amt = str(r.get("Amount") or r.get("INR") or "").strip()
    text = " ".join([str(v or "") for v in r.values()]).lower()
    
    is_mf = "liquid" in text or "groww" in text or "etmoney" in text or "et money" in text or "mutual" in text
    is_fd = "56954" in text or "43046" in text or "108000" in text or "108001" in text or "fd amount" in text or "amrit kalasa" in text or "sbi rd" in text
    is_interest = "8000" in text and ("fd" in text or "interest" in text or "rd" in text or "motilal" in text)
    is_scheme = "motilal" in text or "dsp" in text or "parag" in text or "nippon" in text
    
    if is_mf or is_fd or is_interest or is_scheme:
        r["_line"] = idx
        results.append(r)

print(f"Found {len(results)} relevant rows in 2023-2025")

# Sort by date
def parse_d(d_str):
    parts = d_str.split("/")
    if len(parts) == 3:
        return (int(parts[2]), int(parts[1]), int(parts[0]))
    return (0, 0, 0)

results.sort(key=lambda r: parse_d(r.get("Date", "")))

for r in results:
    d = r.get("Date")
    amt = r.get("Amount") or r.get("INR")
    from_acct = r.get("FromAccount") or r.get("Account") or ""
    to_acct = r.get("ToAccount") or ""
    sub = r.get("SubAccount") or ""
    to_sub = r.get("ToSubAccount") or ""
    from_sub = r.get("FromSubAccount") or ""
    cat = r.get("Category") or ""
    tt = r.get("Income/Expense") or ""
    inv_type = r.get("InvestmentTransactionType") or ""
    note = r.get("Note") or ""
    desc = r.get("Description") or ""
    
    # We want to see all rows that touch Liquid MF or FD or RD or platforms
    print(f"Line {r['_line']:5d} | {d:10s} | Type: {tt:12s} | Amt: {amt:>10s} | From: {from_acct[:15]:15s} (sub: {from_sub[:15]:15s}) -> To: {to_acct[:15]:15s} (sub: {to_sub[:15]:15s}) | Sub: {sub[:15]:15s} | InvType: {inv_type:5s} | Note: {note[:30]:30s} | Desc: {desc[:40]:40s}")
