with open("scratch/CAS_Fareeda Groww_Liquid_MF.pdf.txt", "r", encoding="utf-8") as f:
    text = f.read()

lines = text.split("\n")

# Find all occurrences of "Closing Unit Balance:"
for i, line in enumerate(lines):
    if "Closing Unit Balance:" in line:
        # Print preceding 15 lines and succeeding 5 lines
        start = max(0, i - 18)
        end = min(len(lines), i + 3)
        print(f"\n=======================================================")
        print(f"SCHEME AT LINE {i+1}:")
        print("=======================================================")
        for j in range(start, end):
            print(f"{j+1:4d}: {lines[j]}")
