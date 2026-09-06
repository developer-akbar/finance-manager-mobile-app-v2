with open("scratch/CAS_Ammi Groww_Liquid_MF.pdf.txt", "r", encoding="utf-8") as f:
    text = f.read()

lines = text.split("\n")
print(f"Total lines in Ammi CAS: {len(lines)}")
for i, l in enumerate(lines):
    if any(k in l for k in ["Purchase", "Redemption", "Switch", "Refund", "Closing Unit Balance", "ISIN"]):
        print(f"{i+1:3d}: {l}")
