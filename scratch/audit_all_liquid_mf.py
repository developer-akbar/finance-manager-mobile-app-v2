import csv
import json
import re

CSV_FILE = "finman_2026-09-02.csv"

# Load CSV
with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    all_rows = list(csv.DictReader(f))

print(f"Total rows in CSV: {len(all_rows)}")

def is_liquid_mf_related(r):
    acct = str(r.get("Account") or "").strip()
    from_acct = str(r.get("FromAccount") or r.get("Account") or "").strip()
    to_acct = str(r.get("ToAccount") or "").strip()
    sub = str(r.get("SubAccount") or "").strip()
    from_sub = str(r.get("FromSubAccount") or "").strip()
    to_sub = str(r.get("ToSubAccount") or "").strip()
    brokerage = str(r.get("Brokerage") or "").strip()
    cat = str(r.get("Category") or "").strip()
    note = str(r.get("Note") or "").strip()
    desc = str(r.get("Description") or "").strip()
    
    combined = f"{acct} {from_acct} {to_acct} {sub} {from_sub} {to_sub} {brokerage} {cat} {note} {desc}".lower()
    
    # Direct account match
    if to_acct == "Liquid Mutual Funds" or from_acct == "Liquid Mutual Funds" or acct == "Liquid Mutual Funds" or cat == "Liquid Mutual Funds":
        return True, "DIRECT_ACCT"
        
    # Subaccount match
    sub_names = ["fareeda groww", "ammi groww", "ammi grow", "fareeda etmoney", "fareeda et money", "ak etmoney", "ak et money"]
    for sn in sub_names:
        if sn in f"{sub} {from_sub} {to_sub} {brokerage}".lower():
            # Exclude share market rows
            if "share market" in f"{acct} {from_acct} {to_acct} {cat}".lower():
                return False, None
            return True, "SUBACCOUNT_MATCH"
            
    # FD/RD memo rows that fund Liquid MF
    if from_acct == "SBI RD" and "liquid mutual funds" in to_acct.lower():
        return True, "SBI_RD_TO_MF"
        
    # Specific known memo rows
    if "fareeda etmoney" in desc.lower() or "fareeda et money" in desc.lower() or "ammi grow" in desc.lower():
        if not ("share market" in f"{acct} {from_acct} {to_acct}".lower()):
            return True, "DESC_PLATFORM_MATCH"
            
    # Father mutual fund
    if "father mutual fund" in note.lower() or "father mutual fund" in desc.lower():
        return True, "FATHER_MF"

    # Specific 108k trail rows
    if r.get("Date") == "24/03/2023" and ("56954" in desc or "56954" in str(r.get("INR"))):
        return True, "SBI_RD_FD_CREATION"
    if r.get("Date") == "21/02/2023" and "43046" in desc:
        return True, "FAHIM_POST_OFFICE_MEMO"

    return False, None

liquid_mf_rows = []
for idx, r in enumerate(all_rows, start=1):
    matched, reason = is_liquid_mf_related(r)
    if matched:
        r["_line"] = idx
        r["_match_reason"] = reason
        liquid_mf_rows.append(r)

print(f"Total Liquid MF related rows identified: {len(liquid_mf_rows)}")

# Count by category / type / platform
platform_counts = {}
for r in liquid_mf_rows:
    sub = r.get("SubAccount") or "(none)"
    desc = r.get("Description") or ""
    note = r.get("Note") or ""
    tt = r.get("Income/Expense") or ""
    amt = r.get("Amount") or r.get("INR") or "0"
    
    # Infer actual platform from desc/sub
    text = f"{sub} {note} {desc}".lower()
    plat = "Unknown"
    if "etmoney" in text or "et money" in text:
        plat = "Fareeda ETMoney"
    elif "ammi" in text:
        plat = "Ammi Groww"
    elif "fareeda" in text or "groww" in text:
        plat = "Fareeda Groww"
    elif r["_match_reason"] == "SBI_RD_FD_CREATION":
        plat = "SBI RD (FD Principal)"
    elif r["_match_reason"] == "FAHIM_POST_OFFICE_MEMO":
        plat = "Digi (Fahim Post Office Memo)"
    
    platform_counts[plat] = platform_counts.get(plat, 0) + 1

print("\nBreakdown by Inferred Platform:")
for p, c in sorted(platform_counts.items()):
    print(f"   {p}: {c} rows")

with open("scratch/liquid_mf_rows.json", "w", encoding="utf-8") as f:
    json.dump(liquid_mf_rows, f, indent=2)

print("\nSaved rows to scratch/liquid_mf_rows.json")
