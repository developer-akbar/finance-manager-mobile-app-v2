import re

with open("scratch/CAS_Fareeda Groww_Liquid_MF.pdf.txt", "r", encoding="utf-8") as f:
    text = f.read()

lines = text.split("\n")
for i, line in enumerate(lines):
    if any(k in line.lower() for k in ["dsp", "next 50", "eop-0002", "etmoney", "et money", "49,997", "50,000"]):
        start = max(0, i - 4)
        end = min(len(lines), i + 5)
        print(f"\n--- Line {i+1} ---")
        for j in range(start, end):
            print(f"{j+1:5d}: {lines[j]}")
