import re
from collections import defaultdict

def parse_all_cas_allotments(filepath, label):
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
    cur_txns = []
    
    for i, line in enumerate(lines):
        line_s = line.strip()
        
        if "Folio No:" in line_s:
            cur_folio = line_s.replace("Folio No:", "").strip()
            
        if "ISIN:" in line_s:
            m_isin = re.search(r'ISIN:\s*([A-Z0-9]{12})', line_s)
            if m_isin:
                cur_isin = m_isin.group(1)
            cur_name = line_s
            for k in range(max(0, i-4), i):
                if any(w in lines[k] for w in ["Fund", "Direct", "Growth", "DSP", "PPFAS", "HDFC", "Motilal", "Mirae", "Nippon", "Quant"]):
                    cur_name = lines[k].strip() + " " + cur_name
            cur_mode = "DEMAT" if "(Demat" in line_s or "(Demat" in cur_name else "NON_DEMAT"
            cur_txns = []
            
        # Check transaction line
        # e.g.: 19-May-2025 4,999.75 26.4717188.872SIP Purchase-BSE - Instalment No - 1 - INZ000208032 188.872
        # e.g.: 19-May-2025 0.25*** Stamp Duty ***
        m_dt = re.match(r'^(\d{2}-[A-Za-z]{3}-\d{4})\s+(.*)$', line_s)
        if m_dt and cur_isin:
            dt = m_dt.group(1)
            rest = m_dt.group(2).strip()
            if "*** Stamp Duty ***" in rest:
                m_sd = re.search(r'^([\d,\.]+)\s*\*\*\*\s*Stamp Duty', rest)
                if m_sd and cur_txns:
                    cur_txns[-1]["stamp_duty"] = float(m_sd.group(1).replace(",", ""))
            elif any(kw in rest for kw in ["Purchase", "Systematic Investment", "Sys. Investment"]):
                # Pattern: Amount (with optional comma) followed by PriceUnitsTransaction
                # Amount is float with comma e.g. 4,999.75 or 599.97 or 49,997.50
                # Let's extract Amount first
                m_amt = re.match(r'^([\d,]+\.\d{2})\s+(.*)$', rest)
                if m_amt:
                    net_amt = float(m_amt.group(1).replace(",", ""))
                    rem = m_amt.group(2).strip()
                    # Now rem contains: Price (NAV) + Units + Transaction + Balance
                    # In KFintech and CAMS, let's see how NAV and Units are separated or concatenated
                    # Let's test a regex or split
                    cur_txns.append({
                        "date": dt,
                        "net_amt": net_amt,
                        "stamp_duty": 0.0,
                        "rem": rem
                    })
                    
        if "Closing Unit Balance:" in line_s:
            m_cl = re.search(r'Closing Unit Balance:\s*([\d,\.]+)\s*Total Cost Value:\s*([\d,\.]+)', line_s)
            if m_cl:
                cur_closing_units = float(m_cl.group(1).replace(",", ""))
                cur_closing_cost = float(m_cl.group(2).replace(",", ""))
                
            schemes.append({
                "label": label,
                "folio": cur_folio,
                "isin": cur_isin,
                "name": cur_name,
                "mode": cur_mode,
                "closing_units": cur_closing_units,
                "closing_cost": cur_closing_cost,
                "txns": list(cur_txns)
            })
            cur_txns = []

    return schemes

f_schemes = parse_all_cas_allotments("scratch/CAS_Fareeda Groww_Liquid_MF.pdf.txt", "Fareeda")
a_schemes = parse_all_cas_allotments("scratch/CAS_Ammi Groww_Liquid_MF.pdf.txt", "Ammi")

total_active_f = sum(1 for s in f_schemes if s["closing_units"] > 0)
total_active_a = sum(1 for s in a_schemes if s["closing_units"] > 0)
print(f"Active Fareeda Schemes: {total_active_f} (expected 14)")
print(f"Active Ammi Schemes: {total_active_a} (expected 5)")

total_txns = 0
for s in f_schemes + a_schemes:
    if s["closing_units"] > 0:
        # Note: In Fareeda ETMoney Folio 8470103 / 05, it has 1 active holding (DSP Next 50) and 1 redeemed (DSP Nifty)
        # In DSP Next 50 (Folio 8470103 / 05), it had an earlier 30k FD holding that was redeemed on 14-Nov, and 50k reinvestment on 28-Nov!
        # Let's count txns
        active_txns = [t for t in s["txns"] if not (s['folio'] == '8470103 / 05' and t['date'] == '12-Jun-2024')]
        total_txns += len(active_txns)
        print(f"[{s['mode']:<9}] Folio: {s['folio']:<18} | ISIN: {s['isin']} | Cost: {s['closing_cost']:>9.2f} | Units: {s['closing_units']:>9.3f} | Txns: {len(active_txns)}")

print(f"\nTotal Active Mapped Acquisition Tranches: {total_txns} (Target: 110)")
