import csv

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

print(f"Total Transactions in CSV: {len(rows)}")

def resolve_subaccount(t, parent_asset=""):
    parent = parent_asset or t.get("InvestmentAccount") or t.get("Account") or t.get("ToAccount") or t.get("FromAccount") or ""
    inv_type = str(t.get("InvestmentTransactionType") or "").strip().upper()
    
    sub = str(
        t.get("SubAccount") or
        (t.get("ToSubAccount") if inv_type == "BUY" else t.get("FromSubAccount")) or
        t.get("Brokerage") or
        t.get("ToSubAccount") or
        t.get("FromSubAccount") or ""
    ).strip()
    if sub and sub != "Default":
        return sub

    src = str(t.get("Source") or "").strip()
    if "CAS" in src or "CAMS" in src:
        return "Ak ETMoney"

    note = str(t.get("Note") or "").lower()
    desc = str(t.get("Description") or "").lower()
    combined = f"{note} {desc}"
    parent_lower = parent.lower()

    if "share market" in parent_lower:
        if "groww" in combined or "fareeda" in combined:
            return "Fareeda Groww"
        return "Zerodha"

    if "tax saver" in parent_lower:
        return "Ak ETMoney"

    if "liquid" in parent_lower:
        if "ammi grow" in combined or "ammi" in combined:
            return "Ammi Groww"
        if "fareeda" in combined and "groww" in combined:
            return "Fareeda Groww"
        if "fareeda" in combined and "etmoney" in combined:
            return "Fareeda ETMoney"
        if "scripbox" in combined:
            return "Scripbox"
        if "groww" in combined:
            return "Fareeda Groww"
        if t.get("InvestmentTransactionType") or t.get("SecurityISIN"):
            return "Ak ETMoney"
        return "Fareeda Groww" # Fallback in Accounts.jsx for unassigned Liquid MF

    return None

def compute_parent_balance(txns, acct_name):
    bal = 0.0
    for t in txns:
        amt = float(t.get("Amount") or t.get("INR") or 0.0)
        ttype = str(t.get("Income/Expense") or "").strip()
        acct = t.get("Account") or t.get("FromAccount") or ""
        dest = t.get("ToAccount") or ""

        if ttype == "Income":
            if acct == acct_name: bal += amt
        elif ttype == "Expense":
            if acct == acct_name: bal -= amt
        elif ttype == "Transfer-Out":
            if acct == acct_name: bal -= amt
            if dest == acct_name: bal += amt
    return bal

def compute_subaccount_balance(txns, acct_name, sub_name):
    bal = 0.0
    for t in txns:
        amt = float(t.get("Amount") or t.get("INR") or 0.0)
        ttype = str(t.get("Income/Expense") or "").strip()
        acct = str(t.get("Account") or "").strip()
        from_acct = str(t.get("FromAccount") or t.get("Account") or "").strip()
        dest = str(t.get("ToAccount") or "").strip()
        inv_type = str(t.get("InvestmentTransactionType") or "").strip().upper()
        trade_val = float(t.get("TradeValue") or amt)

        sub = str(t.get("SubAccount") or "").strip()
        from_sub = str(t.get("FromSubAccount") or "").strip()
        to_sub = str(t.get("ToSubAccount") or "").strip()

        is_from_inv = from_acct in ["Mutual Funds Tax Saver", "Liquid Mutual Funds", "Share Market"]
        is_dest_inv = dest in ["Mutual Funds Tax Saver", "Liquid Mutual Funds", "Share Market"]
        is_acct_inv = acct in ["Mutual Funds Tax Saver", "Liquid Mutual Funds", "Share Market"]

        resolved_from_sub = from_sub if (from_sub and from_sub != "Default") else (resolve_subaccount(t, from_acct) if is_from_inv else (sub if (sub and sub != "Default") else ""))
        resolved_to_sub = to_sub if (to_sub and to_sub != "Default") else (resolve_subaccount(t, dest) if is_dest_inv else (sub if (sub and sub != "Default") else ""))
        resolved_acct_sub = sub if (sub and sub != "Default") else (resolve_subaccount(t, acct) if is_acct_inv else "")

        if inv_type == "BUY":
            target_acct = dest or acct
            target_sub = resolved_to_sub if dest else resolved_acct_sub
            if target_acct == acct_name and target_sub == sub_name:
                bal += (trade_val or amt)
        elif inv_type == "SELL":
            target_acct = from_acct or acct
            target_sub = resolved_from_sub if from_acct else resolved_acct_sub
            if target_acct == acct_name and target_sub == sub_name:
                bal -= (trade_val or amt)
        elif ttype == "Income":
            target_acct = dest or acct
            target_sub = resolved_to_sub if dest else resolved_acct_sub
            if target_acct == acct_name and target_sub == sub_name:
                bal += amt
        elif ttype == "Expense":
            target_acct = from_acct or acct
            target_sub = resolved_from_sub if from_acct else resolved_acct_sub
            if target_acct == acct_name and target_sub == sub_name:
                bal -= amt
        elif ttype == "Transfer-Out":
            if from_acct == acct_name and resolved_from_sub == sub_name:
                bal -= amt
            if dest == acct_name and resolved_to_sub == sub_name:
                bal += amt
    return bal

print("=== BEFORE NORMALIZATION ===")
print("Total Transactions:", len(rows))
p_before = compute_parent_balance(rows, "Liquid Mutual Funds")
fg_before = compute_subaccount_balance(rows, "Liquid Mutual Funds", "Fareeda Groww")
fetm_before = compute_subaccount_balance(rows, "Liquid Mutual Funds", "Fareeda ETMoney")
ag_before = compute_subaccount_balance(rows, "Liquid Mutual Funds", "Ammi Groww")
aketm_before = compute_subaccount_balance(rows, "Liquid Mutual Funds", "Ak ETMoney")

print(f"Parent Liquid MF: Rs. {p_before:,.2f}")
print(f"  Fareeda Groww:   Rs. {fg_before:,.2f}")
print(f"  Fareeda ETMoney: Rs. {fetm_before:,.2f}")
print(f"  Ammi Groww:      Rs. {ag_before:,.2f}")
print(f"  Ak ETMoney:      Rs. {aketm_before:,.2f}")

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

normalized_rows = []
for r in rows:
    r_copy = dict(r)
    rid = r_copy.get("ID")
    if rid in TARGET_MODS:
        r_copy["SubAccount"] = TARGET_MODS[rid]
    normalized_rows.append(r_copy)

print("\n=== AFTER NORMALIZATION ===")
print("Total Transactions:", len(normalized_rows))
p_after = compute_parent_balance(normalized_rows, "Liquid Mutual Funds")
fg_after = compute_subaccount_balance(normalized_rows, "Liquid Mutual Funds", "Fareeda Groww")
fetm_after = compute_subaccount_balance(normalized_rows, "Liquid Mutual Funds", "Fareeda ETMoney")
ag_after = compute_subaccount_balance(normalized_rows, "Liquid Mutual Funds", "Ammi Groww")
aketm_after = compute_subaccount_balance(normalized_rows, "Liquid Mutual Funds", "Ak ETMoney")

print(f"Parent Liquid MF: Rs. {p_after:,.2f}")
print(f"  Fareeda Groww:   Rs. {fg_after:,.2f}")
print(f"  Fareeda ETMoney: Rs. {fetm_after:,.2f}")
print(f"  Ammi Groww:      Rs. {ag_after:,.2f}")
print(f"  Ak ETMoney:      Rs. {aketm_after:,.2f}")

print("\n=== BALANCE MOVEMENTS ===")
print(f"Fareeda Groww:   Rs. {fg_before:,.2f} -> Rs. {fg_after:,.2f}  (Delta: Rs. {fg_after - fg_before:,.2f})")
print(f"Fareeda ETMoney: Rs. {fetm_before:,.2f} -> Rs. {fetm_after:,.2f}  (Delta: Rs. {fetm_after - fetm_before:,.2f})")
print(f"Ammi Groww:      Rs. {ag_before:,.2f} -> Rs. {ag_after:,.2f}  (Delta: Rs. {ag_after - ag_before:,.2f})")
print(f"Ak ETMoney:      Rs. {aketm_before:,.2f} -> Rs. {aketm_after:,.2f}  (Delta: Rs. {aketm_after - aketm_before:,.2f})")
print(f"Parent Balance:  Rs. {p_before:,.2f} -> Rs. {p_after:,.2f}  (Delta: Rs. {p_after - p_before:,.2f})")

