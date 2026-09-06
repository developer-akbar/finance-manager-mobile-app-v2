import csv
import re
import json

CSV_FILE = "finman_2026-09-02.csv"

# Keywords from user prompt
KEYWORDS = [
    "fareeda groww", "fareeda etmoney", "fareeda et money",
    "ammi grow", "ammi groww", "ak etmoney", "ak et money",
    "liquid mutual funds", "liquid mf", "fd amount",
    "father mutual fund", "fahim", "fd interest", "rd",
    "108000", "100000", "56954", "43046", "8000",
    "motilal", "dsp nifty", "parag parikh", "nippon",
    "mirae", "quant"
]

def clean_str(val):
    return str(val or "").strip()

def matches_search(row):
    # Check structured fields first
    acct = clean_str(row.get("Account")).lower()
    from_acct = clean_str(row.get("FromAccount")).lower()
    to_acct = clean_str(row.get("ToAccount")).lower()
    sub = clean_str(row.get("SubAccount")).lower()
    from_sub = clean_str(row.get("FromSubAccount")).lower()
    to_sub = clean_str(row.get("ToSubAccount")).lower()
    brokerage = clean_str(row.get("Brokerage")).lower()
    cat = clean_str(row.get("Category")).lower()
    subcat = clean_str(row.get("Subcategory")).lower()
    note = clean_str(row.get("Note")).lower()
    desc = clean_str(row.get("Description")).lower()
    sec_sym = clean_str(row.get("SecuritySymbol")).lower()
    isin = clean_str(row.get("SecurityISIN")).lower()
    amt_str = clean_str(row.get("Amount") or row.get("INR") or "")

    combined_text = f"{acct} {from_acct} {to_acct} {sub} {from_sub} {to_sub} {brokerage} {cat} {subcat} {note} {desc} {sec_sym} {isin} {amt_str}"

    # Is it related to Liquid Mutual Funds?
    # Either parent account is Liquid Mutual Funds / Liquid MF
    # Or SubAccount is Fareeda Groww / Ammi Groww / Fareeda ETMoney / Ak ETMoney
    # Or description/note has keywords
    for kw in KEYWORDS:
        if kw in combined_text:
            return True, kw
            
    return False, None

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    reader = csv.DictReader(f)
    rows = list(reader)

print(f"Total rows in CSV: {len(rows)}")

matched_rows = []
for idx, r in enumerate(rows, start=1):
    matched, kw = matches_search(r)
    if matched:
        r["_line_number"] = idx
        r["_matched_kw"] = kw
        matched_rows.append(r)

print(f"Total candidate rows matched: {len(matched_rows)}")

# Group by category / account to filter out unrelated noise (e.g. general shopping with quant or mirae or rd if not MF)
out_candidates = []
for r in matched_rows:
    acct = clean_str(r.get("Account"))
    from_acct = clean_str(r.get("FromAccount"))
    to_acct = clean_str(r.get("ToAccount"))
    cat = clean_str(r.get("Category"))
    sub = clean_str(r.get("SubAccount"))
    to_sub = clean_str(r.get("ToSubAccount"))
    from_sub = clean_str(r.get("FromSubAccount"))
    note = clean_str(r.get("Note"))
    desc = clean_str(r.get("Description"))
    amt = clean_str(r.get("Amount") or r.get("INR"))
    
    out_candidates.append({
        "line": r["_line_number"],
        "id": r.get("ID"),
        "date": r.get("Date"),
        "type": r.get("Income/Expense"),
        "from": from_acct or acct,
        "to": to_acct,
        "sub": sub,
        "from_sub": from_sub,
        "to_sub": to_sub,
        "cat": cat,
        "note": note,
        "desc": desc,
        "amount": amt,
        "inv_type": r.get("InvestmentTransactionType"),
        "sec": r.get("SecuritySymbol"),
        "kw": r["_matched_kw"]
    })

with open("scratch/all_candidates.json", "w", encoding="utf-8") as f:
    json.dump(out_candidates, f, indent=2)

print("Saved all candidates to scratch/all_candidates.json")
