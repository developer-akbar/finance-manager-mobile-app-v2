import csv
import re
from collections import defaultdict

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

# Let's inspect all candidate transactions by scheme name
def find_rows_by_keywords(include_words, exclude_words=[], min_amt=0, max_amt=1000000, sub_filter=None):
    res = []
    for idx, r in enumerate(rows, 1):
        note = (r.get("Note") or "").lower()
        desc = (r.get("Description") or "").lower()
        cat = (r.get("Category") or "").lower()
        sub = (r.get("SubAccount") or "").strip()
        to_sub = (r.get("ToSubAccount") or "").strip()
        from_sub = (r.get("FromSubAccount") or "").strip()
        amt = float(r.get("Amount") or r.get("INR") or 0)
        to_a = (r.get("ToAccount") or "").strip()
        from_a = (r.get("FromAccount") or r.get("Account") or "").strip()
        
        # Must touch Liquid MF or be subaccount
        if not (to_a == "Liquid Mutual Funds" or from_a == "Liquid Mutual Funds" or cat == "liquid mutual funds" or "liquid" in (sub + to_sub + from_sub).lower()):
            continue
            
        combined = f"{note} {desc} {sub} {to_sub}"
        
        if all(w.lower() in combined for w in include_words):
            if not any(w.lower() in combined for w in exclude_words):
                if min_amt <= amt <= max_amt:
                    if sub_filter is None or sub_filter.lower() in (sub + to_sub).lower():
                        r["_line"] = idx
                        res.append(r)
    return res

print("=== MAPPING AUDIT SCRIPT INITIALIZED ===")

# 1. HDFC Mid-Cap (Demat, Folio 41564472 / 84, Cost: 24,000, Units: 107.744)
hdfc_rows = find_rows_by_keywords(["hdfc", "mid"])
print(f"\nHDFC Mid-Cap candidates: {len(hdfc_rows)} rows")
for r in hdfc_rows:
    print(f"  Line {r['_line']:5d} | {r.get('Date')} | Rs. {float(r.get('Amount')):>8.2f} | Note: {r.get('Note'):<25} | Sub: {r.get('SubAccount')} | ToSub: {r.get('ToSubAccount')}")

# 2. Mirae Asset Large & Midcap (Demat, Folio 78887871745 / 0, Cost: 12,000, Units: 69.377)
mirae_rows = find_rows_by_keywords(["mirae", "large"])
print(f"\nMirae Large & Midcap candidates: {len(mirae_rows)} rows")
for r in mirae_rows:
    print(f"  Line {r['_line']:5d} | {r.get('Date')} | Rs. {float(r.get('Amount')):>8.2f} | Note: {r.get('Note'):<25} | Sub: {r.get('SubAccount')} | ToSub: {r.get('ToSubAccount')}")

# 3. Motilal Midcap in Fareeda Groww (Non-Demat, Folio 910118443576 / 0, Cost: 30,000, Units: 259.369)
motilal_fg = find_rows_by_keywords(["motilal", "midcap"], ["etmoney", "ammi", "large"], sub_filter="Fareeda Groww")
print(f"\nMotilal Midcap (Fareeda Groww) candidates: {len(motilal_fg)} rows")
for r in motilal_fg:
    print(f"  Line {r['_line']:5d} | {r.get('Date')} | Rs. {float(r.get('Amount')):>8.2f} | Note: {r.get('Note'):<25} | Sub: {r.get('SubAccount')} | ToSub: {r.get('ToSubAccount')}")

# 4. Nippon India Large Cap in Fareeda Groww (Non-Demat, Folio 477405385771 / 0, Cost: 50,000, Units: 486.943)
nippon_large_fg = find_rows_by_keywords(["nippon", "large"], ["ammi"], sub_filter="Fareeda Groww")
print(f"\nNippon Large Cap (Fareeda Groww) candidates: {len(nippon_large_fg)} rows")
for r in nippon_large_fg:
    print(f"  Line {r['_line']:5d} | {r.get('Date')} | Rs. {float(r.get('Amount')):>8.2f} | Note: {r.get('Note'):<25} | Sub: {r.get('SubAccount')} | ToSub: {r.get('ToSubAccount')}")

# 5. Nippon India Small Cap in Fareeda Groww (Non-Demat, Folio 477405389157 / 0, Cost: 30,000, Units: 159.845)
nippon_small_fg = find_rows_by_keywords(["nippon", "small"], sub_filter="Fareeda Groww")
print(f"\nNippon Small Cap (Fareeda Groww) candidates: {len(nippon_small_fg)} rows")
for r in nippon_small_fg:
    print(f"  Line {r['_line']:5d} | {r.get('Date')} | Rs. {float(r.get('Amount')):>8.2f} | Note: {r.get('Note'):<25} | Sub: {r.get('SubAccount')} | ToSub: {r.get('ToSubAccount')}")

# 6. Parag Parikh Flexi Cap in Fareeda Groww (Cost: 44,000 + 40,000 = 84,000, Folio 17087524 & 19824545)
ppfas_fg = find_rows_by_keywords(["parag"], ["ammi"], sub_filter="Fareeda Groww")
print(f"\nParag Parikh (Fareeda Groww) candidates: {len(ppfas_fg)} rows")
for r in ppfas_fg:
    print(f"  Line {r['_line']:5d} | {r.get('Date')} | Rs. {float(r.get('Amount')):>8.2f} | Note: {r.get('Note'):<25} | Sub: {r.get('SubAccount')} | ToSub: {r.get('ToSubAccount')}")

# 7. Father Motilal Nifty Next 50 (Groww vs ETMoney)
father_rows = find_rows_by_keywords(["600"], max_amt=600)
print(f"\nFather SIP candidates: {len(father_rows)} rows")
for r in father_rows:
    print(f"  Line {r['_line']:5d} | {r.get('Date')} | Rs. {float(r.get('Amount')):>8.2f} | Note: {r.get('Note'):<25} | Sub: {r.get('SubAccount')} | ToSub: {r.get('ToSubAccount')}")

