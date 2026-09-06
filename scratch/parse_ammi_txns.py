import re

with open("scratch/CAS_Ammi Groww_Liquid_MF.pdf.txt", "r", encoding="utf-8") as f:
    text = f.read()

lines = text.split("\n")
for i, l in enumerate(lines):
    if re.search(r'\d{2}-[A-Za-z]{3}-\d{4}', l):
        print(f"Line {i+1:3d}: {l}")
