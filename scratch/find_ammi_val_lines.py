with open("scratch/CAS_Ammi Groww_Liquid_MF.pdf.txt", "r", encoding="utf-8") as f:
    text = f.read()

lines = text.split("\n")
for i, l in enumerate(lines):
    if any(k in l for k in ["Market Value", "Valuation", "NAV on"]):
        print(f"Line {i+1:4d}: {l}")
