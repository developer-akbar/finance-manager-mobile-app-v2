import csv

CSV_FILE = "finman_2026-09-02.csv"

target_ids = {
    # Ammi cashback (3 transactions)
    "c24bc7db-14f6-4e3d-8752-f5a243d48d45": ("Ammi Groww", "2144", "6125"),
    "c4843272-3289-4a41-ac3b-59e552377384": ("Ammi Groww", "11801", "4901"),
    "a710ce84-4979-4d31-8537-6060225dd292": ("Ammi Groww", "7630", "4232"),
    # Fareeda ETMoney (8 transactions)
    "6075a44d-a7af-4885-9ae7-8457c3420666": ("Fareeda ETMoney", "50000", "6404"),
    "70bc6df2-f39b-44e1-9795-1f4ca58f0b7b": ("Fareeda ETMoney", "50000", "6405"),
    "78fc33c4-33ee-49e5-ad8b-6d074f8fdf3a": ("Fareeda ETMoney", "-1147", "6577"),
    "be603713-6b6d-48fe-be34-e9254f7b6d86": ("Fareeda ETMoney", "28859", "6578"),
    "7cf8ce64-9fc8-4790-b207-6cc616b79d57": ("Fareeda ETMoney", "3457", "6579"),
    "efdcd0b6-ffb7-4fe4-aa9b-05d26c010f61": ("Fareeda ETMoney", "41457", "6580"),
    "540accf4-76b8-4f76-abfd-02305949ddbd": ("Fareeda ETMoney", "-9262", "6581"),
    "84310067-22a3-4714-9381-5bab6f16cde2": ("Fareeda ETMoney", "288738", "6582"),
}

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

found_targets = []
for idx, r in enumerate(rows, 1):
    rid = r.get("ID")
    if rid in target_ids:
        new_sub, expected_amt, label = target_ids[rid]
        found_targets.append({
            "idx": idx,
            "id": rid,
            "label": label,
            "expected_amt": expected_amt,
            "actual_amt": r.get("Amount") or r.get("INR"),
            "date": r.get("Date"),
            "note": r.get("Note"),
            "desc": r.get("Description").replace("\n", " "),
            "current_sub": r.get("SubAccount"),
            "new_sub": new_sub
        })

print(f"Total matching transactions found: {len(found_targets)}")
for ft in found_targets:
    print(f"Label {ft['label']:>4s} (Row {ft['idx']:5d}) | ID: {ft['id']} | Date: {ft['date']} | Amt: Rs. {float(ft['actual_amt']):>9.2f} | CurrentSub: '{ft['current_sub']}' -> NewSub: '{ft['new_sub']}'")
