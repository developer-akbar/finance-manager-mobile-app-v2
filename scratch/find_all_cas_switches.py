import re

def search_switches(cas_file):
    print(f"\n=======================================================")
    print(f"SEARCHING SWITCHES IN: {cas_file}")
    print(f"=======================================================")
    with open(cas_file, "r", encoding="utf-8") as f:
        text = f.read()

    lines = text.split("\n")
    switch_occurrences = []
    
    # We want to find transaction lines or lines with "switch"
    for i, line in enumerate(lines):
        if "switch" in line.lower():
            # Check if this line is in boiler plate / exit load disclaimer or a real transaction
            # Print context
            start = max(0, i - 3)
            end = min(len(lines), i + 4)
            ctx = lines[start:end]
            # Is it a transaction line or exit load?
            is_disclaimer = any(k in line.lower() for k in ["exit load", "redeemed or switched", "switchout including", "switch out in excess", "switch-out within", "switch-in of units", "switch-out on or before", "switch out, stp out"])
            switch_occurrences.append({
                "line_no": i + 1,
                "text": line.strip(),
                "is_disclaimer": is_disclaimer,
                "context": "\n".join([f"   {lines[k]}" for k in range(start, end)])
            })

    real_switches = [s for s in switch_occurrences if not s["is_disclaimer"]]
    print(f"Total lines mentioning 'switch': {len(switch_occurrences)}")
    print(f"Potential real transaction switches: {len(real_switches)}")
    
    if real_switches:
        print("\n--- Potential Real Switches ---")
        for s in real_switches:
            print(f"Line {s['line_no']}: {s['text']}")
            print(s['context'])
            print()
    else:
        print("No real switch transactions identified by word 'switch'. Checking disclaimers:")
        for s in switch_occurrences[:5]:
            print(f"  Line {s['line_no']}: {s['text']}")

search_switches("scratch/CAS_Fareeda Groww_Liquid_MF.pdf.txt")
search_switches("scratch/CAS_Ammi Groww_Liquid_MF.pdf.txt")
