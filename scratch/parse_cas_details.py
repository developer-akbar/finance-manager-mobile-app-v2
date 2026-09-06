import re

def parse_cas(filename):
    with open(filename, "r", encoding="utf-8") as f:
        text = f.read()

    print(f"\n==========================================")
    print(f"PARSING {filename}")
    print(f"==========================================")

    # Find all schemes and folios
    lines = text.split("\n")
    schemes = []
    current_scheme = None
    
    for i, line in enumerate(lines):
        line_clean = line.strip()
        # Look for Folio No: or Scheme names or totals
        if "Folio No:" in line or "Advisor:" in line or "Registrar:" in line:
            # print snippet
            # print("  INFO:", line_clean)
            pass
        if "Total Cost Value:" in line or "Cost Value:" in line or "Market Value:" in line:
            print("  VALUE LINE:", line_clean)
            
    # Let's search for transactions or dates
    # Typically transactions have dates like DD-Mon-YYYY
    txn_lines = []
    date_pattern = re.compile(r'\b\d{2}-[A-Za-z]{3}-\d{4}\b')
    for line in lines:
        if date_pattern.search(line) and not "Statement" in line and not "To" in line and not "Page" in line:
            txn_lines.append(line.strip())
            
    print(f"Found {len(txn_lines)} transaction lines with dates:")
    for l in txn_lines[:30]:
        print("   ", l)
    if len(txn_lines) > 30:
        print(f"    ... and {len(txn_lines) - 30} more")

parse_cas("scratch/CAS_Fareeda Groww_Liquid_MF.pdf.txt")
parse_cas("scratch/CAS_Ammi Groww_Liquid_MF.pdf.txt")
