import csv

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

# Let's check the redemption on 14/11/2024 (Line 6582)
r6582 = rows[6581] # 0-indexed
print("--- REDEMPTION ON 14/11/2024 (Line 6582) ---")
for k, v in r6582.items():
    if v:
        print(f"  {k}: {v}")

# Search all purchase transactions of this DSP security
# Note: Line 6582 description says: "Fareeda ETMONEY DSP Nifty 50: 298000 - 288738: -9262 loss"
# Note column says: "Redemption"
# Let's find all purchases between 01-Jul-2023 and 31-Oct-2024 where Note or Description mentions DSP Nifty (and NOT DSP Next 50)

dsp_purchases = []
for idx, r in enumerate(rows, 1):
    to_a = (r.get("ToAccount") or "").strip()
    from_a = (r.get("FromAccount") or r.get("Account") or "").strip()
    ttype = (r.get("Income/Expense") or "").strip()
    note = (r.get("Note") or "").strip()
    desc = (r.get("Description") or "").strip()
    amt = float(r.get("Amount") or r.get("INR") or 0)
    
    # Is it an inflow into Liquid Mutual Funds?
    if to_a == "Liquid Mutual Funds" and ttype == "Transfer-Out":
        text = f"{note} {desc}".lower()
        # Look for DSP Nifty, excluding DSP Next 50
        if "dsp nifty" in text and not ("next 50" in text or "next50" in text):
            # Also exclude Ammi Grow rows
            if "ammi" not in text and "dwakra" not in text:
                r["_line"] = idx
                dsp_purchases.append(r)

print(f"\n--- CANDIDATE DSP PURCHASES FOUND: {len(dsp_purchases)} ---")
total_amt = sum(float(r.get("Amount") or 0) for r in dsp_purchases)
print(f"Total Amount of Candidate Purchases: Rs. {total_amt:,.2f}")

for r in dsp_purchases:
    amt = float(r.get("Amount") or 0)
    sub = r.get("SubAccount") or ""
    to_sub = r.get("ToSubAccount") or ""
    print(f"Line {r['_line']:5d} | ID: {r.get('ID')} | Date: {r.get('Date')} | Amt: Rs. {amt:>9.2f} | Note: {r.get('Note'):<25} | Sub: '{sub}' | ToSub: '{to_sub}' | Desc: {r.get('Description').replace(chr(10), ' ')[:50]}")
