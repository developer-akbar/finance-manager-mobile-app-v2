import re
from collections import defaultdict

def parse_cas_transactions(txt_path, cas_label):
    with open(txt_path, "r", encoding="utf-8") as f:
        text = f.read()

    lines = text.split("\n")
    
    schemes = []
    cur_scheme = None
    
    for i, line in enumerate(lines):
        line_s = line.strip()
        
        # Check scheme header with ISIN
        if "ISIN:" in line_s:
            m_isin = re.search(r'ISIN:\s*([A-Z0-9]{12})', line_s)
            isin = m_isin.group(1) if m_isin else ""
            
            # Advisor
            m_adv = re.search(r'Advisor:\s*([A-Za-z0-9\-]+)', line_s)
            adv = m_adv.group(1) if m_adv else ""
            
            # Folio: look up to 4 lines back or 8 lines forward
            folio = ""
            for k in range(max(0, i-4), min(len(lines), i+8)):
                if "Folio No:" in lines[k]:
                    folio = lines[k].replace("Folio No:", "").strip()
                    break
                    
            # Scheme name
            name = line_s
            for k in range(max(0, i-3), i):
                if any(w in lines[k] for w in ["Fund", "Direct", "Growth", "DSP", "PPFAS", "HDFC", "Motilal", "Mirae", "Nippon", "Quant"]):
                    name = lines[k].strip() + " " + name
                    
            mode = "DEMAT" if "(Demat" in line_s or "(Demat" in name else "NON_DEMAT"
            
            cur_scheme = {
                "cas": cas_label,
                "isin": isin,
                "folio": folio,
                "mode": mode,
                "advisor": adv,
                "name": name,
                "raw_lines": [],
                "txns": [],
                "closing_units": 0.0,
                "closing_cost": 0.0,
                "nav": 0.0,
                "market_val": 0.0
            }
            schemes.append(cur_scheme)
            
        elif cur_scheme:
            # Check closing units
            if "Closing Unit Balance:" in line_s:
                m_u = re.search(r'Closing Unit Balance:\s*([\d,\.]+)\s*Total Cost Value:\s*([\d,\.]+)', line_s)
                if m_u:
                    cur_scheme["closing_units"] = float(m_u.group(1).replace(",", ""))
                    cur_scheme["closing_cost"] = float(m_u.group(2).replace(",", ""))
            if "NAV on" in line_s:
                m_nav = re.search(r'NAV on [^:]+:\s*INR\s*([\d,\.]+)\s*Market Value on [^:]+:\s*INR\s*([\d,\.]+)', line_s)
                if m_nav:
                    cur_scheme["nav"] = float(m_nav.group(1).replace(",", ""))
                    cur_scheme["market_val"] = float(m_nav.group(2).replace(",", ""))
                    
            # Store raw lines between ISIN and next ISIN / Page
            cur_scheme["raw_lines"].append(line_s)

    return schemes

f_schemes = parse_cas_transactions("scratch/CAS_Fareeda Groww_Liquid_MF.pdf.txt", "Fareeda")
a_schemes = parse_cas_transactions("scratch/CAS_Ammi Groww_Liquid_MF.pdf.txt", "Ammi")

print(f"Fareeda CAS schemes parsed: {len(f_schemes)}")
print(f"Ammi CAS schemes parsed: {len(a_schemes)}")

for idx, s in enumerate(f_schemes, 1):
    print(f"\n{idx:2d}. [{s['mode']}] Folio: {s['folio']:<18} | ISIN: {s['isin']} | Cost: {s['closing_cost']:>9.2f} | Units: {s['closing_units']:>9.3f}")
    # Print sample transaction-like lines
    for l in s["raw_lines"]:
        if re.search(r'\d{2}-[A-Za-z]{3}-\d{4}', l):
            print(f"     Txn Line: {l[:100]}")

