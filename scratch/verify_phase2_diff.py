import csv

BAK_FILE = "scratch/finman_2026-09-02.phase1.bak"
NEW_FILE = "finman_2026-09-02.csv"

with open(BAK_FILE, "r", encoding="utf-8-sig") as f:
    bak_rows = list(csv.DictReader(f))

with open(NEW_FILE, "r", encoding="utf-8-sig") as f:
    new_rows = list(csv.DictReader(f))

assert len(bak_rows) == len(new_rows), "Row counts do not match!"

diffs = []
for i in range(len(bak_rows)):
    r_bak = bak_rows[i]
    r_new = new_rows[i]
    changes = {}
    for k in r_bak:
        if r_bak[k] != r_new[k]:
            changes[k] = (r_bak[k], r_new[k])
    if changes:
        diffs.append((i + 1, r_bak.get("ID"), changes))

print(f"Total rows modified in Phase 2: {len(diffs)}")
assert len(diffs) == 17, f"Expected exactly 17 rows changed, but got {len(diffs)}"

for row_idx, rid, chgs in diffs:
    print(f"Row {row_idx:5d} (ID: {rid[:8]}):")
    for col, (old_v, new_v) in chgs.items():
        print(f"   Column '{col}': '{old_v}' -> '{new_v}'")
