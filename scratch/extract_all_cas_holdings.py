import re
import csv
from collections import defaultdict

# 1. Parse Fareeda CAS
with open("scratch/CAS_Fareeda Groww_Liquid_MF.pdf.txt", "r", encoding="utf-8") as f:
    f_text = f.read()

# 2. Parse Ammi CAS
with open("scratch/CAS_Ammi Groww_Liquid_MF.pdf.txt", "r", encoding="utf-8") as f:
    a_text = f.read()

def parse_cas_schemes(text, cas_name):
    lines = text.split("\n")
    schemes = []
    
    current_folio = ""
    current_isin = ""
    current_name = ""
    current_advisor = ""
    current_units = 0.0
    current_cost = 0.0
    current_nav = 0.0
    current_val = 0.0
    
    for i, line in enumerate(lines):
        line_s = line.strip()
        if "Folio No:" in line_s:
            current_folio = line_s.replace("Folio No:", "").strip()
            
        m_isin = re.search(r'ISIN:\s*([A-Z0-9]{12})', line_s)
        if m_isin:
            current_isin = m_isin.group(1)
            # Advisor
            m_adv = re.search(r'Advisor:\s*([A-Za-z0-9\-]+)', line_s)
            current_advisor = m_adv.group(1) if m_adv else ""
            # Name is often preceding text or in this line
            current_name = line_s
            
        if "Closing Unit Balance:" in line_s:
            m_units = re.search(r'Closing Unit Balance:\s*([\d,\.]+)', line_s)
            m_cost = re.search(r'Total Cost Value:\s*([\d,\.]+)', line_s)
            if m_units:
                current_units = float(m_units.group(1).replace(",", ""))
            if m_cost:
                current_cost = float(m_cost.group(1).replace(",", ""))
                
        if "Valuation on" in line_s or "Total Valuation on" in line_s:
            m_nav = re.search(r'NAV on [^:]+:\s*([\d,\.]+)', line_s)
            m_val = re.search(r'Total Cost Value:[^\(]+\(INR\):\s*([\d,\.]+)', line_s)
            if m_nav:
                current_nav = float(m_nav.group(1).replace(",", ""))
            if m_val:
                current_val = float(m_val.group(1).replace(",", ""))
                
            if current_isin:
                schemes.append({
                    "cas": cas_name,
                    "folio": current_folio,
                    "isin": current_isin,
                    "name": current_name,
                    "advisor": current_advisor,
                    "units": current_units,
                    "cost": current_cost,
                    "nav": current_nav,
                    "val": current_val
                })
                # reset
                current_isin = ""
                current_units = 0.0
                current_cost = 0.0
                current_nav = 0.0
                current_val = 0.0

    return schemes

f_schemes = parse_cas_schemes(f_text, "Fareeda")
a_schemes = parse_cas_schemes(a_text, "Ammi")

print(f"Fareeda CAS schemes found: {len(f_schemes)}")
print(f"Ammi CAS schemes found: {len(a_schemes)}")

print("\n--- FAREEDA CAS SCHEMES ---")
for s in f_schemes:
    status = "ACTIVE" if s["units"] > 0 else "REDEEMED"
    print(f"[{status:<8}] Folio: {s['folio']:<18} | ISIN: {s['isin']} | Units: {s['units']:>10.3f} | Cost: Rs. {s['cost']:>10.2f} | Adv: {s['advisor']:<15} | Name: {s['name'][:40]}")

print("\n--- AMMI CAS SCHEMES ---")
for s in a_schemes:
    status = "ACTIVE" if s["units"] > 0 else "REDEEMED"
    print(f"[{status:<8}] Folio: {s['folio']:<18} | ISIN: {s['isin']} | Units: {s['units']:>10.3f} | Cost: Rs. {s['cost']:>10.2f} | Adv: {s['advisor']:<15} | Name: {s['name'][:40]}")
