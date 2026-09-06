import re

def parse_full_cas(filename):
    with open(filename, "r", encoding="utf-8") as f:
        text = f.read()

    print(f"\n=======================================================")
    print(f"FULL SCHEME SUMMARY FOR: {filename}")
    print(f"=======================================================")

    pages = text.split("--- Page ")
    current_folio = ""
    current_scheme = ""
    schemes = []

    # Scheme blocks often start with Folio No: or Scheme name line
    # Let's find all blocks between scheme headers and "Closing Unit Balance"
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if "Folio No:" in line:
            current_folio = line
        elif "ISIN:" in line:
            # Scheme name is usually above or on this line
            scheme_name = lines[i-1].strip() if i > 0 else ""
            isin = line
            # look ahead for transactions and closing unit balance
            closing_cost = 0.0
            closing_units = 0.0
            txns = []
            j = i + 1
            while j < len(lines):
                jl = lines[j].strip()
                if "Closing Unit Balance:" in jl:
                    # extract units and cost
                    m = re.search(r'Closing Unit Balance:\s*([\d,\.]+)\s*Total Cost Value:\s*([\d,\.]+)', jl)
                    if m:
                        closing_units = float(m.group(1).replace(",", ""))
                        closing_cost = float(m.group(2).replace(",", ""))
                    break
                # Check for transaction line
                m_date = re.match(r'^(\d{2}-[A-Za-z]{3}-\d{4})\s+([\d,\.]+)\s+([\d,\.]+)\s+([\d,\.]+)(.*)$', jl)
                if m_date:
                    txns.append({
                        "date": m_date.group(1),
                        "amount": float(m_date.group(2).replace(",", "")),
                        "nav": float(m_date.group(3).replace(",", "")),
                        "units": float(m_date.group(4).replace(",", "")),
                        "desc": m_date.group(5).strip()
                    })
                elif re.match(r'^\d{2}-[A-Za-z]{3}-\d{4}', jl) and "Purchase" in jl:
                    txns.append({"raw": jl})
                j += 1
            schemes.append({
                "folio": current_folio,
                "scheme": scheme_name,
                "isin": isin,
                "closing_units": closing_units,
                "closing_cost": closing_cost,
                "txns": txns
            })
            i = j
        i += 1

    total_cost = sum(s["closing_cost"] for s in schemes)
    print(f"Total schemes found: {len(schemes)}, Total Cost: Rs. {total_cost:,.2f}")
    for idx, s in enumerate(schemes, 1):
        print(f"\n{idx}. {s['scheme']}")
        print(f"   {s['folio']} | {s['isin']}")
        print(f"   Closing Units: {s['closing_units']:,.3f} | Cost: Rs. {s['closing_cost']:,.2f} | Txns count: {len(s['txns'])}")
        for t in s['txns'][:5]:
            print(f"      {t}")
        if len(s['txns']) > 5:
            print(f"      ... {len(s['txns']) - 5} more txns")

parse_full_cas("scratch/CAS_Fareeda Groww_Liquid_MF.pdf.txt")
parse_full_cas("scratch/CAS_Ammi Groww_Liquid_MF.pdf.txt")
