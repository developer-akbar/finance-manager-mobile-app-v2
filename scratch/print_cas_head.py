with open("scratch/CAS_Fareeda Groww_Liquid_MF.pdf.txt", "r", encoding="utf-8") as f:
    text = f.read()

lines = text.split("\n")
print("=== LINES 1 TO 250 OF FAREEDA CAS ===")
for i in range(min(250, len(lines))):
    print(f"{i+1:3d}: {lines[i]}")
