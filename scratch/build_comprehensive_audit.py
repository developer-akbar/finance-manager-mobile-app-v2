import csv
import json
import re

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

# Let's inspect all rows touching Liquid Mutual Funds
def get_row_info(idx, r):
    date = r.get("Date", "").strip()
    tt = r.get("Income/Expense", "").strip()
    amt_str = r.get("Amount") or r.get("INR") or "0"
    amt = float(amt_str) if amt_str else 0.0
    from_acct = (r.get("FromAccount") or r.get("Account") or "").strip()
    to_acct = (r.get("ToAccount") or "").strip()
    sub = (r.get("SubAccount") or "").strip()
    from_sub = (r.get("FromSubAccount") or "").strip()
    to_sub = (r.get("ToSubAccount") or "").strip()
    brokerage = (r.get("Brokerage") or "").strip()
    cat = (r.get("Category") or "").strip()
    note = (r.get("Note") or "").strip()
    desc = (r.get("Description") or "").strip()
    inv_type = (r.get("InvestmentTransactionType") or "").strip()
    sec = (r.get("SecuritySymbol") or "").strip()
    units = (r.get("Quantity") or "").strip()
    nav = (r.get("UnitPrice") or "").strip()
    trade_val = (r.get("TradeValue") or "").strip()
    cost_basis = (r.get("CostBasis") or "").strip()
    source = (r.get("Source") or "").strip()
    
    text = f"{from_acct} {to_acct} {sub} {from_sub} {to_sub} {brokerage} {cat} {note} {desc}".lower()
    
    return {
        "line": idx,
        "id": r.get("ID"),
        "date": date,
        "type": tt,
        "from": from_acct,
        "to": to_acct,
        "sub": sub,
        "from_sub": from_sub,
        "to_sub": to_sub,
        "brokerage": brokerage,
        "cat": cat,
        "note": note,
        "desc": desc,
        "amt": amt,
        "inv_type": inv_type,
        "sec": sec,
        "units": units,
        "nav": nav,
        "trade_val": trade_val,
        "cost_basis": cost_basis,
        "source": source,
        "text": text
    }

parsed_rows = [get_row_info(idx, r) for idx, r in enumerate(rows, 1)]

# Identify all Liquid MF related rows
# Exclude pure Mutual Funds Tax Saver rows (which have to_acct=Mutual Funds Tax Saver and no liquid MF context)
# Exclude pure Share Market rows
lmf_rows = []
for p in parsed_rows:
    from_acct = p["from"]
    to_acct = p["to"]
    cat = p["cat"]
    sub = p["sub"]
    note = p["note"]
    desc = p["desc"]
    text = p["text"]
    
    # 1. Direct Liquid Mutual Funds in From/To/Cat
    is_direct_lmf = (to_acct == "Liquid Mutual Funds" or from_acct == "Liquid Mutual Funds" or cat == "Liquid Mutual Funds")
    
    # Exclude if it's strictly Share Market or Mutual Funds Tax Saver
    if "tax saver" in to_acct.lower() or "tax saver" in cat.lower():
        if not is_direct_lmf:
            continue
    if "share market" in to_acct.lower() or "share market" in cat.lower():
        if not is_direct_lmf:
            continue
            
    # 2. SubAccount / Desc platforms
    is_sub_lmf = any(s in text for s in ["fareeda groww", "fareeda etmoney", "fareeda et money", "ammi grow", "ammi groww"])
    
    # 3. 108k money trail rows
    is_108k_trail = False
    if p["line"] == 12110 or (p["date"] == "24/03/2023" and abs(p["amt"] - 56954.0) < 0.01):
        is_108k_trail = True
    if p["line"] == 12411 or (p["date"] == "21/02/2023" and "43046" in desc):
        is_108k_trail = True
    if from_acct == "SBI RD" and to_acct == "Liquid Mutual Funds":
        is_108k_trail = True

    if is_direct_lmf or is_sub_lmf or is_108k_trail:
        # Double check: ensure not a Share Market row (e.g. Zerodha or Share Market Investment)
        if "share market" in from_acct.lower() or "share market" in to_acct.lower() or "equity" in cat.lower():
            if not is_direct_lmf:
                continue
        lmf_rows.append(p)

print(f"Total Liquid MF rows to audit: {len(lmf_rows)}")

# Output summary to JSON
with open("scratch/lmf_audit_rows.json", "w", encoding="utf-8") as f:
    json.dump(lmf_rows, f, indent=2)

print("Saved scratch/lmf_audit_rows.json")
