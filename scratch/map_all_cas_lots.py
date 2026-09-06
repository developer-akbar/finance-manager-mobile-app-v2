import csv
import re
from collections import defaultdict

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

# Let's index transactions in Liquid Mutual Funds
lmf_txns = []
for idx, r in enumerate(rows, 1):
    to_a = (r.get("ToAccount") or "").strip()
    from_a = (r.get("FromAccount") or r.get("Account") or "").strip()
    cat = (r.get("Category") or "").strip()
    sub = (r.get("SubAccount") or "").strip()
    to_sub = (r.get("ToSubAccount") or "").strip()
    from_sub = (r.get("FromSubAccount") or "").strip()
    
    if to_a == "Liquid Mutual Funds" or from_a == "Liquid Mutual Funds" or cat == "Liquid Mutual Funds":
        r["_line"] = idx
        lmf_txns.append(r)

print(f"Total Liquid MF transactions in CSV: {len(lmf_txns)}")

# Let's write mapping functions for each holding
# 1. Fareeda Groww: DSP Nifty Next 50 (Non-Demat, Folio 10185451 / 05, Cost Rs. 55,000, Units 2,044.940)
# CAS purchases:
# Let's extract from CAS_Fareeda Groww_Liquid_MF.pdf.txt the exact purchase dates and amounts for Folio 10185451 / 05!

with open("scratch/CAS_Fareeda Groww_Liquid_MF.pdf.txt", "r", encoding="utf-8") as f:
    cas_f_text = f.read()

# Let's write a parser for all transaction lines in Fareeda CAS
lines = cas_f_text.split("\n")
cas_folios = defaultdict(list)
cur_folio = ""
cur_isin = ""
for l in lines:
    if "Folio No:" in l:
        cur_folio = l.replace("Folio No:", "").strip()
    if "ISIN:" in l:
        m = re.search(r'ISIN:\s*([A-Z0-9]{12})', l)
        if m: cur_isin = m.group(1)
    m_txn = re.match(r'^(\d{2}-[A-Za-z]{3}-\d{4})\s+([\d,\.\(\)]+)\s+([\d,\.\(\)]+)\s+([\d,\.\(\)]+)(.*)$', l.strip())
    if m_txn and cur_folio:
        date = m_txn.group(1)
        amt = m_txn.group(2)
        nav = m_txn.group(3)
        units = m_txn.group(4)
        desc = m_txn.group(5).strip()
        cas_folios[(cur_folio, cur_isin)].append({
            "date": date, "amt": amt, "nav": nav, "units": units, "desc": desc
        })

print(f"\nUnique (Folio, ISIN) combinations in Fareeda CAS: {len(cas_folios)}")
for (fol, isin), txns in cas_folios.items():
    print(f"Folio: {fol:<20} | ISIN: {isin} | Txns: {len(txns)}")

