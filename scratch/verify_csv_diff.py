import csv

BAK_FILE = "scratch/finman_2026-09-02.csv.bak"
NEW_FILE = "finman_2026-09-02.csv"

with open(BAK_FILE, "r", encoding="utf-8-sig") as f:
    bak_rows = list(csv.DictReader(f))

with open(NEW_FILE, "r", encoding="utf-8-sig") as f:
    new_rows = list(csv.DictReader(f))

print(f"Bak row count: {len(bak_rows)}")
print(f"New row count: {len(new_rows)}")
assert len(bak_rows) == len(new_rows), "Row counts do not match!"

diffs = []
for i in range(len(bak_rows)):
    r_bak = bak_rows[i]
    r_new = new_rows[i]
    
    # Check if anything changed
    changes = {}
    for k in r_bak:
        if r_bak[k] != r_new[k]:
            changes[k] = (r_bak[k], r_new[k])
            
    if changes:
        diffs.append((i + 1, r_bak.get("ID"), changes))

print(f"\nTotal rows with differences: {len(diffs)}")
for row_idx, rid, chgs in diffs:
    print(f"Row {row_idx:5d} (ID: {rid}):")
    for col, (old_v, new_v) in chgs.items():
        print(f"   Column '{col}': '{old_v}' -> '{new_v}'")

