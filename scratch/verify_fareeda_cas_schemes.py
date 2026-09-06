import re

with open("scratch/CAS_Fareeda Groww_Liquid_MF.pdf.txt", "r", encoding="utf-8") as f:
    text = f.read()

lines = text.split("\n")

schemes = []
i = 0
while i < len(lines):
    line = lines[i].strip()
    if "ISIN:" in line:
        scheme_name = lines[i-1].strip() if i > 0 else ""
        isin = line
        folio = ""
        # Search backwards for folio
        for k in range(max(0, i-5), i):
            if "Folio No:" in lines[k]:
                folio = lines[k].strip()
                break
        
        # Search forward for closing unit balance and advisor
        closing_cost = 0.0
        closing_units = 0.0
        advisor = ""
        j = i
        while j < min(len(lines), i + 80):
            jl = lines[j].strip()
            if "Advisor:" in jl:
                m_adv = re.search(r'Advisor:\s*([^\)]+)', jl)
                if m_adv: advisor = m_adv.group(1).strip()
            if "Closing Unit Balance:" in jl:
                m = re.search(r'Closing Unit Balance:\s*([\d,\.]+)\s*Total Cost Value:\s*([\d,\.]+)', jl)
                if m:
                    closing_units = float(m.group(1).replace(",", ""))
                    closing_cost = float(m.group(2).replace(",", ""))
                break
            j += 1
        schemes.append({
            "scheme": scheme_name,
            "isin": isin,
            "folio": folio,
            "advisor": advisor,
            "units": closing_units,
            "cost": closing_cost
        })
        i = j
    i += 1

print(f"Total schemes in Fareeda CAS: {len(schemes)}")
total_cost = 0.0
etm_cost = 0.0
groww_cost = 0.0

for idx, s in enumerate(schemes, 1):
    c = s["cost"]
    total_cost += c
    adv = s["advisor"]
    is_etm = "eop-0002" in adv.lower()
    if is_etm:
        etm_cost += c
        tag = "ETMONEY"
    else:
        groww_cost += c
        tag = "GROWW"
    print(f"{idx:2d}. [{tag:7s}] Cost: Rs. {c:>10.2f} | Units: {s['units']:>10.3f} | Adv: {adv:15s} | {s['scheme'][:40]} | Folio: {s['folio']}")

print(f"\nTotal CAS Cost:   Rs. {total_cost:,.2f}")
print(f"Total ETMoney:    Rs. {etm_cost:,.2f}")
print(f"Total Groww:      Rs. {groww_cost:,.2f}")
