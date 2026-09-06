with open("scratch/CAS_Ammi Groww_Liquid_MF.pdf.txt", "r", encoding="utf-8") as f:
    ammi_text = f.read()

with open("scratch/CAS_Fareeda Groww_Liquid_MF.pdf.txt", "r", encoding="utf-8") as f:
    fareeda_text = f.read()

print("=== SEARCHING 'QUANT' IN AMMI CAS ===")
ammi_lines = ammi_text.split("\n")
ammi_quant_lines = [l for l in ammi_lines if "quant" in l.lower()]
print(f"Found {len(ammi_quant_lines)} lines with 'quant' in Ammi CAS:")
for l in ammi_quant_lines:
    print("  ", l)

print("\n=== SEARCHING 'QUANT' IN FAREEDA CAS ===")
fareeda_lines = fareeda_text.split("\n")
fareeda_quant_lines = []
for i, l in enumerate(fareeda_lines):
    if "quant" in l.lower():
        fareeda_quant_lines.append((i+1, l))
print(f"Found {len(fareeda_quant_lines)} lines with 'quant' in Fareeda CAS:")
for idx, l in fareeda_quant_lines[:20]:
    print(f"   Line {idx}: {l}")

print("\n=== SEARCHING DATES 11-JUL-2024 TO 20-SEP-2024 IN AMMI CAS ===")
import re
for i, l in enumerate(ammi_lines):
    m = re.search(r'\b\d{2}-[A-Za-z]{3}-2024\b', l)
    if m:
        print(f"   Line {i+1}: {l}")
