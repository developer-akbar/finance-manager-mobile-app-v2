with open("scratch/CAS_Fareeda Groww_Liquid_MF.pdf.txt", "r", encoding="utf-8") as f:
    text = f.read()

lines = text.split("\n")

# Find all "ISIN:" lines and trace exact scheme name, folio, advisor, units, and cost
scheme_records = []
for i, line in enumerate(lines):
    if "ISIN:" in line:
        isin_line = line
        # Scheme name is in isin_line or in line above
        # Look backwards for Folio No: or Fund House
        fund_house = ""
        scheme_name = ""
        for k in range(max(0, i-6), i+1):
            if "Mutual Fund" in lines[k] or "PPFAS" in lines[k] or "Quant MF" in lines[k]:
                fund_house = lines[k].strip()
        
        # Folio line
        folio = ""
        for k in range(i, min(len(lines), i+8)):
            if "Folio No:" in lines[k]:
                folio = lines[k].strip()
                break
                
        # Look forward for closing unit balance
        closing_cost = 0.0
        closing_units = 0.0
        closing_line = ""
        for k in range(i, min(len(lines), i+120)):
            if "Closing Unit Balance:" in lines[k]:
                closing_line = lines[k].strip()
                import re
                m = re.search(r'Closing Unit Balance:\s*([\d,\.]+)\s*Total Cost Value:\s*([\d,\.]+)', closing_line)
                if m:
                    closing_units = float(m.group(1).replace(",", ""))
                    closing_cost = float(m.group(2).replace(",", ""))
                break
                
        scheme_records.append({
            "line_idx": i+1,
            "raw_isin_line": isin_line.strip(),
            "fund_house": fund_house,
            "folio": folio,
            "units": closing_units,
            "cost": closing_cost
        })

print(f"Total schemes found: {len(scheme_records)}")
for idx, s in enumerate(scheme_records, 1):
    print(f"\n--- Scheme {idx} (Line {s['line_idx']}) ---")
    print(f"  Header/ISIN: {s['raw_isin_line']}")
    print(f"  Folio:       {s['folio']}")
    print(f"  Units:       {s['units']:,.3f} | Cost: Rs. {s['cost']:,.2f}")
