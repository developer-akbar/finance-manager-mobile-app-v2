import csv

CSV_FILE = "finman_2026-09-02.csv"

target_ids = [
    "c24bc7db-14f6-4e3d-8752-f5a243d48d45", # 6125
    "c4843272-3289-4a41-ac3b-59e552377384", # 4901
    "a710ce84-4979-4d31-8537-6060225dd292", # 4232
    "6075a44d-a7af-4885-9ae7-8457c3420666", # 6404
    "70bc6df2-f39b-44e1-9795-1f4ca58f0b7b", # 6405
    "78fc33c4-33ee-49e5-ad8b-6d074f8fdf3a", # 6577
    "be603713-6b6d-48fe-be34-e9254f7b6d86", # 6578
    "7cf8ce64-9fc8-4790-b207-6cc616b79d57", # 6579
    "efdcd0b6-ffb7-4fe4-aa9b-05d26c010f61", # 6580
    "540accf4-76b8-4f76-abfd-02305949ddbd", # 6581
    "84310067-22a3-4714-9381-5bab6f16cde2", # 6582
]

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

for r in rows:
    rid = r.get("ID")
    if rid in target_ids:
        print(f"ID {rid[:8]} | Date: {r.get('Date')} | Amt: {r.get('Amount')} | Type: {r.get('Income/Expense')}")
        print(f"   From: {r.get('FromAccount') or r.get('Account')} | To: {r.get('ToAccount')}")
        print(f"   SubAccount: '{r.get('SubAccount')}' | FromSubAccount: '{r.get('FromSubAccount')}' | ToSubAccount: '{r.get('ToSubAccount')}'")
