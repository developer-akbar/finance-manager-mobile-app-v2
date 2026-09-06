import csv
from simulate_normalization import compute_parent_balance, compute_subaccount_balance

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

TARGET_MODS = {
  # Ammi cashback (3 transactions)
  "c24bc7db-14f6-4e3d-8752-f5a243d48d45": "Ammi Groww", # 6125
  "c4843272-3289-4a41-ac3b-59e552377384": "Ammi Groww", # 4901
  "a710ce84-4979-4d31-8537-6060225dd292": "Ammi Groww", # 4232
  # Fareeda ETMoney (8 transactions)
  "6075a44d-a7af-4885-9ae7-8457c3420666": "Fareeda ETMoney", # 6404
  "70bc6df2-f39b-44e1-9795-1f4ca58f0b7b": "Fareeda ETMoney", # 6405
  "78fc33c4-33ee-49e5-ad8b-6d074f8fdf3a": "Fareeda ETMoney", # 6577
  "be603713-6b6d-48fe-be34-e9254f7b6d86": "Fareeda ETMoney", # 6578
  "7cf8ce64-9fc8-4790-b207-6cc616b79d57": "Fareeda ETMoney", # 6579
  "efdcd0b6-ffb7-4fe4-aa9b-05d26c010f61": "Fareeda ETMoney", # 6580
  "540accf4-76b8-4f76-abfd-02305949ddbd": "Fareeda ETMoney", # 6581
  "84310067-22a3-4714-9381-5bab6f16cde2": "Fareeda ETMoney", # 6582
}

fg_before = compute_subaccount_balance(rows, "Liquid Mutual Funds", "Fareeda Groww")
fetm_before = compute_subaccount_balance(rows, "Liquid Mutual Funds", "Fareeda ETMoney")
ag_before = compute_subaccount_balance(rows, "Liquid Mutual Funds", "Ammi Groww")
p_before = compute_parent_balance(rows, "Liquid Mutual Funds")

normalized_rows = []
for r in rows:
    r_copy = dict(r)
    rid = r_copy.get("ID")
    if rid in TARGET_MODS:
        target_sub = TARGET_MODS[rid]
        r_copy["SubAccount"] = target_sub
        if r_copy.get("ToAccount") == "Liquid Mutual Funds":
            r_copy["ToSubAccount"] = target_sub
        if r_copy.get("FromAccount") == "Liquid Mutual Funds":
            r_copy["FromSubAccount"] = target_sub
    normalized_rows.append(r_copy)

fg_after = compute_subaccount_balance(normalized_rows, "Liquid Mutual Funds", "Fareeda Groww")
fetm_after = compute_subaccount_balance(normalized_rows, "Liquid Mutual Funds", "Fareeda ETMoney")
ag_after = compute_subaccount_balance(normalized_rows, "Liquid Mutual Funds", "Ammi Groww")
p_after = compute_parent_balance(normalized_rows, "Liquid Mutual Funds")

print("=== RESULTS WITH CONSISTENT SUBACCOUNT METADATA ===")
print(f"Parent Balance:  Rs. {p_before:,.2f} -> Rs. {p_after:,.2f}  (Delta: Rs. {p_after - p_before:,.2f})")
print(f"Fareeda Groww:   Rs. {fg_before:,.2f} -> Rs. {fg_after:,.2f}  (Delta: Rs. {fg_after - fg_before:,.2f})")
print(f"Fareeda ETMoney: Rs. {fetm_before:,.2f} -> Rs. {fetm_after:,.2f}  (Delta: Rs. {fetm_after - fetm_before:,.2f})")
print(f"Ammi Groww:      Rs. {ag_before:,.2f} -> Rs. {ag_after:,.2f}  (Delta: Rs. {ag_after - ag_before:,.2f})")
