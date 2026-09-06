import re

def parse_cas_file(cas_path, label):
    with open(cas_path, "r", encoding="utf-8") as f:
        text = f.read()
    lines = text.split("\n")
    
    schemes = []
    for i, line in enumerate(lines):
        if "ISIN:" in line:
            isin_line = line
            m_isin = re.search(r'ISIN:\s*([A-Z0-9]{12})', line)
            isin = m_isin.group(1) if m_isin else "UNKNOWN"
            
            # Advisor
            m_adv = re.search(r'Advisor:\s*([A-Za-z0-9\-]+)', line)
            adv = m_adv.group(1) if m_adv else ""
            
            # Folio
            folio = ""
            for k in range(max(0, i-4), min(len(lines), i+8)):
                if "Folio No:" in lines[k]:
                    folio = lines[k].replace("Folio No:", "").strip()
                    break
                    
            # Scheme name: lines above or in this line
            raw_name = ""
            for k in range(max(0, i-3), i+1):
                l_k = lines[k].strip()
                if "Fund" in l_k or "Direct" in l_k or "Growth" in l_k:
                    raw_name += " " + l_k
            if not raw_name:
                raw_name = isin_line
                
            # Clean name
            clean_name = raw_name.strip()
            # Remove PAN, KYC etc if present
            clean_name = re.sub(r'PAN:[^\s]+|KYC:[^\s]+', '', clean_name).strip()
            
            # Look forward for closing unit balance and valuation
            closing_units = 0.0
            closing_cost = 0.0
            nav = 0.0
            cur_val = 0.0
            
            for k in range(i, min(len(lines), i+120)):
                if "Closing Unit Balance:" in lines[k]:
                    m = re.search(r'Closing Unit Balance:\s*([\d,\.]+)\s*Total Cost Value:\s*([\d,\.]+)', lines[k])
                    if m:
                        closing_units = float(m.group(1).replace(",", ""))
                        closing_cost = float(m.group(2).replace(",", ""))
                if "Valuation on" in lines[k] or "NAV on" in lines[k]:
                    m_nav = re.search(r'NAV on [^:]+:\s*([\d,\.]+)', lines[k])
                    m_val = re.search(r'\(INR\):\s*([\d,\.]+)', lines[k])
                    if m_nav:
                        nav = float(m_nav.group(1).replace(",", ""))
                    if m_val:
                        cur_val = float(m_val.group(1).replace(",", ""))
                # Stop if next ISIN
                if k > i and "ISIN:" in lines[k]:
                    break

            schemes.append({
                "label": label,
                "isin": isin,
                "folio": folio,
                "advisor": adv,
                "name": clean_name,
                "units": closing_units,
                "cost": closing_cost,
                "nav": nav,
                "val": cur_val
            })
    return schemes

f_schemes = parse_cas_file("scratch/CAS_Fareeda Groww_Liquid_MF.pdf.txt", "Fareeda Groww / ETMoney")
a_schemes = parse_cas_file("scratch/CAS_Ammi Groww_Liquid_MF.pdf.txt", "Ammi Groww")

print(f"Total Fareeda CAS Schemes: {len(f_schemes)}")
print(f"Total Ammi CAS Schemes: {len(a_schemes)}")

print("\n=========================================================================================")
print("FAREEDA CAS SCHEMES")
print("=========================================================================================")
for idx, s in enumerate(f_schemes, 1):
    status = "ACTIVE" if s["units"] > 0 else "REDEEMED"
    print(f"{idx:2d}. [{status:<8}] Folio: {s['folio']:<18} | ISIN: {s['isin']} | Units: {s['units']:>10.3f} | Cost: Rs. {s['cost']:>10.2f} | NAV: {s['nav']:>8.2f} | Val: Rs. {s['val']:>10.2f} | Adv: {s['advisor']}")
    print(f"    Name: {s['name'][:80]}")

print("\n=========================================================================================")
print("AMMI CAS SCHEMES")
print("=========================================================================================")
for idx, s in enumerate(a_schemes, 1):
    status = "ACTIVE" if s["units"] > 0 else "REDEEMED"
    print(f"{idx:2d}. [{status:<8}] Folio: {s['folio']:<18} | ISIN: {s['isin']} | Units: {s['units']:>10.3f} | Cost: Rs. {s['cost']:>10.2f} | NAV: {s['nav']:>8.2f} | Val: Rs. {s['val']:>10.2f} | Adv: {s['advisor']}")
    print(f"    Name: {s['name'][:80]}")
