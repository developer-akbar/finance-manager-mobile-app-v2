import csv

BAK_FILE = "scratch/finman_2026-09-02.phase2.bak"
NEW_FILE = "finman_2026-09-02.csv"

with open(BAK_FILE, "r", encoding="utf-8-sig") as f:
    bak_rows = list(csv.DictReader(f))

with open(NEW_FILE, "r", encoding="utf-8-sig") as f:
    new_rows = list(csv.DictReader(f))

assert len(bak_rows) == len(new_rows) == 28849, "Row counts do not match!"

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

print(f"Total rows modified in Phase 5: {len(diffs)}")
assert len(diffs) == 111, f"Expected exactly 111 rows changed, but got {len(diffs)}"

# Check that no protected lines were modified
protected_lines = [12110, 12411, 8529, 7931, 8157, 8158, 7894, 7247]
for r_idx, rid, chgs in diffs:
    assert r_idx not in protected_lines, f"Protected line {r_idx} modified!"

print("Verified: Exactly 111 rows modified, 0 protected rows touched!")
