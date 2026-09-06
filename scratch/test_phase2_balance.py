import csv
from test_subaccount_update import compute_parent_balance, compute_subaccount_balance

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

DSP_17_IDS = [
    "6e55e5ac-9d2e-47c7-a16e-71c56452c3ee", # 6971: 23000
    "e9b70da8-db53-4ec9-a0a8-56908bd148d1", # 7228: 50000
    "67e2552f-b1b0-4fc5-9819-011fc792bc58", # 7489: 100000
    "ca66768f-b994-4aa2-9ab2-598daf44fb71", # 7751: 50000
    "5aaf60e6-2ece-4dc6-9a0c-deeb97ed982e", # 7946: 10000
    "acd961ec-2be7-4c82-b4bb-59d75e4ae555", # 8213: 10000
    "7ac21162-604a-43c0-a868-e23c28cbdf2c", # 8493: 5000
    "4992f3ec-ec7f-4e8a-abd0-41d5dea65cbb", # 8747: 5000
    "841de93e-0356-4c69-bd89-8aed6c6948bd", # 8981: 5000
    "10d793a1-f4af-41eb-828e-7d41865d3cd2", # 9258: 5000
    "a8952038-e29e-467e-a9f0-5f100ee49fef", # 9493: 5000
    "b8d23e14-8e24-40d3-bf7d-905ddc848562", # 9778: 5000
    "ca401ed4-50f4-45a6-84aa-2be06b722427", # 10000: 5000
    "637da1f3-2676-4e23-8596-6934346b58b5", # 10372: 5000
    "7c9fdf01-8788-457c-b2a6-b17ff1ebb310", # 10640: 5000
    "35199c20-83be-4d6b-b3ad-127241c5a308", # 10967: 5000
    "5121808e-3569-49c4-b5dd-135065db76ca", # 11300: 5000
]

print(f"Total DSP 17 IDs: {len(DSP_17_IDS)}")

# Calculate before Phase 2
p_before = compute_parent_balance(rows, "Liquid Mutual Funds")
fg_before = compute_subaccount_balance(rows, "Liquid Mutual Funds", "Fareeda Groww")
fetm_before = compute_subaccount_balance(rows, "Liquid Mutual Funds", "Fareeda ETMoney")
ag_before = compute_subaccount_balance(rows, "Liquid Mutual Funds", "Ammi Groww")
aketm_before = compute_subaccount_balance(rows, "Liquid Mutual Funds", "Ak ETMoney")

# Apply Phase 2
phase2_rows = []
sum_moved = 0
for r in rows:
    r_copy = dict(r)
    rid = r_copy.get("ID")
    if rid in DSP_17_IDS:
        r_copy["SubAccount"] = "Fareeda ETMoney"
        if r_copy.get("ToAccount") == "Liquid Mutual Funds":
            r_copy["ToSubAccount"] = "Fareeda ETMoney"
        sum_moved += float(r_copy.get("Amount") or 0)
    phase2_rows.append(r_copy)

print(f"Sum of moved DSP 17 transactions: Rs. {sum_moved:,.2f}")
assert sum_moved == 298000.0, "Sum must be exactly 298,000!"

# Calculate after Phase 2
p_after = compute_parent_balance(phase2_rows, "Liquid Mutual Funds")
fg_after = compute_subaccount_balance(phase2_rows, "Liquid Mutual Funds", "Fareeda Groww")
fetm_after = compute_subaccount_balance(phase2_rows, "Liquid Mutual Funds", "Fareeda ETMoney")
ag_after = compute_subaccount_balance(phase2_rows, "Liquid Mutual Funds", "Ammi Groww")
aketm_after = compute_subaccount_balance(phase2_rows, "Liquid Mutual Funds", "Ak ETMoney")

print("\n=== PHASE 2 BALANCE RESULTS ===")
print(f"Parent Liquid MF: Rs. {p_before:,.2f} -> Rs. {p_after:,.2f} (Delta: Rs. {p_after - p_before:,.2f})")
print(f"Fareeda Groww:   Rs. {fg_before:,.2f} -> Rs. {fg_after:,.2f} (Delta: Rs. {fg_after - fg_before:,.2f})")
print(f"Fareeda ETMoney: Rs. {fetm_before:,.2f} -> Rs. {fetm_after:,.2f} (Delta: Rs. {fetm_after - fetm_before:,.2f})")
print(f"Ammi Groww:      Rs. {ag_before:,.2f} -> Rs. {ag_after:,.2f} (Delta: Rs. {ag_after - ag_before:,.2f})")
print(f"Ak ETMoney:      Rs. {aketm_before:,.2f} -> Rs. {aketm_after:,.2f} (Delta: Rs. {aketm_after - aketm_before:,.2f})")
