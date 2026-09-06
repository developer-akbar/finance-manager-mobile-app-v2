import csv

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    reader = csv.DictReader(f)
    fieldnames = reader.fieldnames
    rows = list(reader)

target_lines = [6125, 4901, 4232, 6404, 6405, 6577, 6578, 6579, 6580, 6581, 6582]

print(f"Total rows in CSV: {len(rows)}")
print(f"SubAccount column present: {'SubAccount' in fieldnames}")

for l in target_lines:
    # l is 1-indexed line number in CSV file, meaning header is line 1, so row index is l - 2!
    # Wait! Let's check whether l was 1-indexed line number in file or 1-indexed row number!
    # In our previous script:
    # for idx, r in enumerate(rows, 1): r['_line'] = idx
    # That meant idx was 1-indexed ROW index (excluding header).
    # In file, header is line 1, so row idx=1 is line 2!
    # Let's check both idx = l and idx = l - 1 to see which one has the exact ID and amount!
    for test_idx in [l, l - 1, l - 2]:
        if 0 <= test_idx < len(rows):
            r = rows[test_idx]
            amt = r.get("Amount") or r.get("INR")
            d = r.get("Date")
            note = r.get("Note")
            if any(k in f"{amt} {d} {note}".lower() for k in ["2144", "11801", "7630", "50000", "28859", "41457", "288738", "-1147", "3457", "-9262"]):
                print(f"Target {l} matched at row index {test_idx} (File line {test_idx + 2}): ID={r.get('ID')}, Date={d}, Amt={amt}, Note={note}, CurrentSub='{r.get('SubAccount')}'")
                break
