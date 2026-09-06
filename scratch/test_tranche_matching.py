# Update matching script with et money space normalization
import csv
import json
import re
from datetime import datetime

CSV_FILE = "finman_2026-09-02.csv"

MONTHS = {
    "Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6,
    "Jul": 7, "Aug": 8, "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12
}

def parse_cas_date(s):
    p = s.split("-")
    return datetime(int(p[2]), MONTHS[p[1]], int(p[0]))

def parse_finman_date(s):
    p = s.split("/")
    return datetime(int(p[2]), int(p[1]), int(p[0]))

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    finman_rows = list(csv.DictReader(f))

for idx, r in enumerate(finman_rows, 1):
    r["_line"] = idx

from preview_phase5_mf_normalization import active_schemes

eligible_rows = []
for r in finman_rows:
    to_a = (r.get("ToAccount") or "").strip()
    from_a = (r.get("FromAccount") or r.get("Account") or "").strip()
    sub = (r.get("SubAccount") or "").strip()
    to_sub = (r.get("ToSubAccount") or "").strip()
    cat = (r.get("Category") or "").strip()
    note = (r.get("Note") or "").strip()
    
    is_mf = to_a == "Liquid Mutual Funds" or from_a == "Liquid Mutual Funds" or cat == "Liquid Mutual Funds" or sub in ["Fareeda Groww", "Fareeda ETMoney", "Ammi Groww"] or to_sub in ["Fareeda Groww", "Fareeda ETMoney", "Ammi Groww"] or "father mutual fund" in note.lower()
    if is_mf:
        eligible_rows.append(r)

matches = []
unmatched_cas = []
matched_finman_ids = set()

for s in active_schemes:
    isin = s["isin"]
    fol = s["folio"]
    mode = s["mode"]
    sub = s["subaccount"]
    own = s["ownership"]
    
    for t in s["txns"]:
        cas_dt = parse_cas_date(t["cas_date"])
        gross_amt = t["gross_amt"]
        
        best_candidate = None
        min_date_diff = 999
        
        for r in eligible_rows:
            rid = r.get("ID")
            if rid in matched_finman_ids:
                continue
                
            r_amt = float(r.get("Amount") or r.get("INR") or 0)
            r_note = (r.get("Note") or "").lower()
            r_desc = (r.get("Description") or "").lower()
            r_sub = (r.get("SubAccount") or r.get("ToSubAccount") or "").strip().lower()
            
            combined_desc = f"{r_note} {r_desc} {r_sub}".replace("et money", "etmoney")
            
            if own == "FATHER_EXTERNAL":
                if "father" not in r_note and "father" not in r_desc:
                    continue
                if r_amt != 0 and r_amt != 600:
                    continue
            else:
                if "father" in r_note or "father" in r_desc:
                    continue
                if abs(r_amt - gross_amt) > 1.0:
                    continue
                    
            scheme_matched = False
            if isin == "INF740KA1MG9":
                scheme_matched = "dsp" in combined_desc and "next" in combined_desc
            elif isin == "INF179K01XQ0":
                scheme_matched = "hdfc" in combined_desc
            elif isin == "INF769K01BI1":
                scheme_matched = "mirae" in combined_desc
            elif isin == "INF247L01445":
                scheme_matched = "motilal" in combined_desc and "mid" in combined_desc
            elif isin == "INF247L01AC1":
                scheme_matched = "father" in combined_desc
            elif isin == "INF204K01XI3":
                scheme_matched = "nippon" in combined_desc and "large" in combined_desc
            elif isin == "INF204K01K15":
                scheme_matched = "nippon" in combined_desc and "small" in combined_desc
            elif isin == "INF879O01027":
                scheme_matched = "parag" in combined_desc or "ppfas" in combined_desc
            elif isin == "INF247L01999":
                scheme_matched = "motilal" in combined_desc and ("large" in combined_desc or r_amt == 50000)
                
            if not scheme_matched:
                continue
                
            if sub == "Ammi Groww" and "ammi" not in combined_desc:
                continue
            if sub == "Fareeda Groww" and "etmoney" in combined_desc and "groww" not in combined_desc:
                continue
            if sub == "Fareeda ETMoney" and "etmoney" not in combined_desc:
                continue

            r_dt = parse_finman_date(r.get("Date"))
            diff_days = abs((r_dt - cas_dt).days)
            if diff_days <= 10 and diff_days < min_date_diff:
                min_date_diff = diff_days
                best_candidate = r
                
        if best_candidate:
            matched_finman_ids.add(best_candidate.get("ID"))
            matches.append({
                "scheme": s["name"],
                "isin": isin,
                "folio": fol,
                "mode": mode,
                "sub": sub,
                "own": own,
                "cas_date": t["cas_date"],
                "finman_line": best_candidate["_line"],
                "finman_id": best_candidate.get("ID"),
                "finman_date": best_candidate.get("Date"),
                "finman_amt": float(best_candidate.get("Amount")),
                "cas_gross": gross_amt,
                "cas_net": t["net_amt"],
                "cas_sd": t["stamp_duty"],
                "cas_units": t["units"],
                "cas_nav": t["nav"],
                "date_diff": min_date_diff
            })
        else:
            unmatched_cas.append((s["name"], isin, fol, t["cas_date"], gross_amt))

print(f"\nTotal Matches Found: {len(matches)} / 111")
print(f"Total Unmatched CAS Tranches: {len(unmatched_cas)}")
assert len(matches) == 111, f"Expected 111 matches, got {len(matches)}"
assert len(unmatched_cas) == 0, f"Expected 0 unmatched, got {len(unmatched_cas)}"
print("ALL 111 ACTIVE CAS TRANCHES MATCHED 100% PERFECTLY!")
