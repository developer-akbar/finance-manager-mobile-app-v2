import re

def parse_all_txns(cas_file):
    print(f"\n=======================================================")
    print(f"ALL TRANSACTIONS IN: {cas_file}")
    print(f"=======================================================")
    with open(cas_file, "r", encoding="utf-8") as f:
        text = f.read()

    lines = text.split("\n")
    current_scheme = ""
    current_folio = ""
    current_isin = ""
    
    txns = []
    
    for i, line in enumerate(lines):
        line_s = line.strip()
        if "Folio No:" in line_s:
            current_folio = line_s
        if "ISIN:" in line_s:
            current_isin = line_s
            current_scheme = lines[i-1].strip() if i > 0 else ""
            
        # Match dates DD-Mon-YYYY
        m = re.match(r'^(\d{2}-[A-Za-z]{3}-\d{4})\s+([\d,\.\(\)]+)\s+([\d,\.\(\)]+)\s+([\d,\.\(\)]+)(.*)$', line_s)
        if m and not "Statement" in line_s and not "NAV on" in line_s and not "Page" in line_s:
            date = m.group(1)
            amt_str = m.group(2)
            price_str = m.group(3)
            units_str = m.group(4)
            desc = m.group(5).strip()
            txns.append({
                "line": i + 1,
                "scheme": current_scheme,
                "folio": current_folio,
                "isin": current_isin,
                "date": date,
                "amt": amt_str,
                "price": price_str,
                "units": units_str,
                "desc": desc
            })
        elif re.match(r'^\d{2}-[A-Za-z]{3}-\d{4}', line_s) and any(k in line_s for k in ["Redemption", "Switch", "Refund", "Adjustment", "Cancelled"]):
            txns.append({
                "line": i + 1,
                "scheme": current_scheme,
                "folio": current_folio,
                "isin": current_isin,
                "raw": line_s
            })

    print(f"Total transactions found: {len(txns)}")
    non_purchases = []
    for t in txns:
        desc = t.get("desc", "") or t.get("raw", "")
        if not ("SIP Purchase" in desc or "Purchase" in desc or "Systematic Investment" in desc or "Stamp Duty" in desc or "Sys. Investment" in desc):
            non_purchases.append(t)
            
    print(f"Non-purchase transactions: {len(non_purchases)}")
    for np in non_purchases:
        print(np)

parse_all_txns("scratch/CAS_Fareeda Groww_Liquid_MF.pdf.txt")
parse_all_txns("scratch/CAS_Ammi Groww_Liquid_MF.pdf.txt")
