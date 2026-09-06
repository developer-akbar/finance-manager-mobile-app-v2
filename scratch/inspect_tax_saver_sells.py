import csv
import json

with open("finman_2026-09-02.csv", "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

for l in [6573, 6574, 6575]:
    r = rows[l - 1]
    print(f"--- Line {l} ---")
    for k, v in r.items():
        if v:
            print(f"  {k}: {v}")
