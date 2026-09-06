import re

def parse_cas_file_blocks(filepath):
    with open(filepath, "r", encoding="utf-8") as f:
        text = f.read()

    lines = text.split("\n")
    schemes = []
    
    cur_folio = ""
    cur_isin = ""
    cur_name = ""
    cur_mode = "NON_DEMAT"
    cur_closing_units = 0.0
    cur_closing_cost = 0.0
    cur_nav = 0.0
    cur_txns = []
    
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        
        if "Folio No:" in line:
            cur_folio = line.replace("Folio No:", "").strip()
            
        if "ISIN:" in line:
            m_isin = re.search(r'ISIN:\s*([A-Z0-9]{12})', line)
            if m_isin:
                cur_isin = m_isin.group(1)
            # Check scheme name and mode
            cur_name = line
            for k in range(max(0, i-4), i):
                if any(w in lines[k] for w in ["Fund", "Direct", "Growth", "DSP", "PPFAS", "HDFC", "Motilal", "Mirae", "Nippon", "Quant"]):
                    cur_name = lines[k].strip() + " " + cur_name
            cur_mode = "DEMAT" if "(Demat" in line or "(Demat" in cur_name else "NON_DEMAT"
            cur_txns = []
            
        # Parse transaction lines
        # Regex for transaction line:
        # e.g.: 19-May-2025 4,999.75 26.4717188.872SIP Purchase-BSE - Instalment No - 1 - INZ000208032 188.872
        # e.g.: 19-May-2025 0.25*** Stamp Duty ***
        # Notice: Date Amount PriceUnits...
        # Look for Date:
        m_date = re.match(r'^(\d{2}-[A-Za-z]{3}-\d{4})\s+(.*)$', line)
        if m_date and cur_isin:
            dt = m_date.group(1)
            rest = m_date.group(2).strip()
            if "*** Stamp Duty ***" in rest:
                # Stamp duty line
                m_sd = re.match(r'^([\d,\.]+)\s*\*\*\*\s*Stamp Duty\s*\*\*\*', rest)
                if m_sd and cur_txns:
                    cur_txns[-1]["stamp_duty"] = float(m_sd.group(1).replace(",", ""))
            elif any(kw in rest for kw in ["Purchase", "SIP Purchase", "Sys. Investment", "Allotment"]):
                # Allotment line
                # Parse: NetAmount, Price (NAV), Units
                # e.g. 4,999.75 26.4717188.872SIP Purchase-BSE...
                # Note: Price and Units may be concatenated if no space between them, e.g. 26.4717 followed by 188.872
                # In CAMS CAS: NAV is typically 4 decimal places, e.g. 26.4717
                m_parts = re.match(r'^([\d,\.]+)\s+([\d\.]+?)(Purchase.*|SIP Purchase.*|Sys\. Investment.*)$', rest)
                
                # Let's check how the numbers look
                cur_txns.append({
                    "date": dt,
                    "raw": rest,
                    "stamp_duty": 0.0
                })
                
        if "Closing Unit Balance:" in line:
            m_cl = re.search(r'Closing Unit Balance:\s*([\d,\.]+)\s*Total Cost Value:\s*([\d,\.]+)', line)
            if m_cl:
                cur_closing_units = float(m_cl.group(1).replace(",", ""))
                cur_closing_cost = float(m_cl.group(2).replace(",", ""))
                
            schemes.append({
                "folio": cur_folio,
                "isin": cur_isin,
                "name": cur_name,
                "mode": cur_mode,
                "closing_units": cur_closing_units,
                "closing_cost": cur_closing_cost,
                "txns": list(cur_txns)
            })
            cur_txns = []
            
        i += 1
        
    return schemes

f_schemes = parse_cas_file_blocks("scratch/CAS_Fareeda Groww_Liquid_MF.pdf.txt")
print(f"Fareeda schemes extracted: {len(f_schemes)}")
for s in f_schemes:
    if s["closing_units"] > 0:
        print(f"\nScheme: {s['name'][:60]}")
        print(f"  Folio: {s['folio']} | ISIN: {s['isin']} | Mode: {s['mode']} | Cost: {s['closing_cost']} | Units: {s['closing_units']} | Txns: {len(s['txns'])}")
        for t in s["txns"]:
            print(f"    {t['date']} | SD: {t['stamp_duty']} | Raw: {t['raw'][:70]}")
