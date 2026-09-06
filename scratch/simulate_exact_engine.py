import csv

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

TARGET_MODS = {
  # 1. Ammi cashback (3 transactions)
  "c24bc7db-14f6-4e3d-8752-f5a243d48d45": "Ammi Groww", # Line 6125 (Rs. 2,144)
  "c4843272-3289-4a41-ac3b-59e552377384": "Ammi Groww", # Line 4901 (Rs. 11,801)
  "a710ce84-4979-4d31-8537-6060225dd292": "Ammi Groww", # Line 4232 (Rs. 7,630)
  # 2. Fareeda ETMoney (8 transactions)
  "6075a44d-a7af-4885-9ae7-8457c3420666": "Fareeda ETMoney", # Line 6404 (Rs. 50,000)
  "70bc6df2-f39b-44e1-9795-1f4ca58f0b7b": "Fareeda ETMoney", # Line 6405 (Rs. 50,000)
  "78fc33c4-33ee-49e5-ad8b-6d074f8fdf3a": "Fareeda ETMoney", # Line 6577 (Rs. -1,147)
  "be603713-6b6d-48fe-be34-e9254f7b6d86": "Fareeda ETMoney", # Line 6578 (Rs. 28,859)
  "7cf8ce64-9fc8-4790-b207-6cc616b79d57": "Fareeda ETMoney", # Line 6579 (Rs. 3,457)
  "efdcd0b6-ffb7-4fe4-aa9b-05d26c010f61": "Fareeda ETMoney", # Line 6580 (Rs. 41,457)
  "540accf4-76b8-4f76-abfd-02305949ddbd": "Fareeda ETMoney", # Line 6581 (Rs. -9,262)
  "84310067-22a3-4714-9381-5bab6f16cde2": "Fareeda ETMoney", # Line 6582 (Rs. 288,738)
}

from test_subaccount_update import compute_parent_balance, compute_subaccount_balance

print("=== BASELINE BEFORE NORMALIZATION ===")
p_before = compute_parent_balance(rows, "Liquid Mutual Funds")
fg_before = compute_subaccount_balance(rows, "Liquid Mutual Funds", "Fareeda Groww")
fetm_before = compute_subaccount_balance(rows, "Liquid Mutual Funds", "Fareeda ETMoney")
ag_before = compute_subaccount_balance(rows, "Liquid Mutual Funds", "Ammi Groww")
aketm_before = compute_subaccount_balance(rows, "Liquid Mutual Funds", "Ak ETMoney")

print(f"Parent Liquid MF Balance: Rs. {p_before:,.2f}")
print(f"  Fareeda Groww:   Rs. {fg_before:,.2f}")
print(f"  Fareeda ETMoney: Rs. {fetm_before:,.2f}")
print(f"  Ammi Groww:      Rs. {ag_before:,.2f}")
print(f"  Ak ETMoney:      Rs. {aketm_before:,.2f}")
print(f"Total Transactions: {len(rows)}")

# Count investment transactions
inv_count = sum(1 for r in rows if (r.get("InvestmentTransactionType") or r.get("SecurityISIN") or r.get("TradeValue")))
print(f"Total Investment Transactions: {inv_count}")

# Check SBI RD baseline
sbi_rd_rows = [r for r in rows if (r.get("FromAccount") == "SBI RD" or r.get("ToAccount") == "SBI RD" or r.get("Account") == "SBI RD")]
sbi_rd_bal = compute_parent_balance(rows, "SBI RD")
print(f"SBI RD Balance: Rs. {sbi_rd_bal:,.2f} ({len(sbi_rd_rows)} transactions)")

# Check Line 7247 baseline
r_7247 = rows[7246]
print(f"Line 7247: ID={r_7247.get('ID')}, SubAccount='{r_7247.get('SubAccount')}', Amt={r_7247.get('Amount')}, Desc={r_7247.get('Description')[:30]}")

# Check Line 8529 (FD Interest) baseline
r_8529 = rows[8528]
print(f"Line 8529: ID={r_8529.get('ID')}, Amt={r_8529.get('Amount')}, Note={r_8529.get('Note')}")

# Check Line 12110 (AK Personal SBI RD) baseline
r_12110 = rows[12109]
print(f"Line 12110: ID={r_12110.get('ID')}, Amt={r_12110.get('Amount')}, Note={r_12110.get('Note')}")

# Check Line 12411 (Fahim Memo) baseline
r_12411 = rows[12410]
print(f"Line 12411: ID={r_12411.get('ID')}, Amt={r_12411.get('Amount')}, Note={r_12411.get('Note')}")

