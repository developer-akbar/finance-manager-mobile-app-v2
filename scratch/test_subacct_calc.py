import csv
import json
from test_subaccount_update import compute_parent_balance, compute_subaccount_balance

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

fg_cur = compute_subaccount_balance(rows, "Liquid Mutual Funds", "Fareeda Groww")
fetm_cur = compute_subaccount_balance(rows, "Liquid Mutual Funds", "Fareeda ETMoney")
ag_cur = compute_subaccount_balance(rows, "Liquid Mutual Funds", "Ammi Groww")
parent_cur = compute_parent_balance(rows, "Liquid Mutual Funds")

print("BEFORE ANY MODIFICATION:")
print(f"  Fareeda Groww:   Rs. {fg_cur}")
print(f"  Fareeda ETMoney: Rs. {fetm_cur}")
print(f"  Ammi Groww:      Rs. {ag_cur}")
print(f"  Parent:          Rs. {parent_cur}")

with open("scratch/phase5_conversion_preview.json", "r", encoding="utf-8") as f:
    conversions = json.load(f)

conv_map = {c["SourceFinManTransactionID"]: c for c in conversions}

# Test option A: TradeValue = gross_amt (keeps nominal 315,000 / 31,994 / 219,490)
rows_opt_a = []
for r in rows:
    r_copy = dict(r)
    rid = r_copy.get("ID")
    if rid in conv_map:
        c = conv_map[rid]
        r_copy["InvestmentTransactionType"] = "BUY"
        r_copy["Brokerage"] = c["SubAccount"]
        r_copy["SubAccount"] = c["SubAccount"]
        r_copy["ToSubAccount"] = c["SubAccount"]
        r_copy["SecuritySymbol"] = c["SecuritySymbol"]
        r_copy["SecurityISIN"] = c["SecurityISIN"]
        r_copy["Quantity"] = str(c["CASUnits"])
        r_copy["UnitPrice"] = str(c["CASNAV"])
        # For TradeValue:
        # If personal/mixed/ammi: TradeValue = Amount (gross bank transfer amount, preserving exact ledger)
        # If Father: TradeValue = 0 (Amount is 0, so cash balance remains 0)
        # Net investment is stored in CostBasis!
        r_copy["TradeValue"] = str(c["CASGrossAmount"]) if c["OwnershipTag"] != "FATHER_EXTERNAL" else "0"
        r_copy["CostBasis"] = str(c["NetInvestmentAmount"])
        r_copy["CashImpact"] = "0"
        r_copy["PositionQuantityChange"] = str(c["PositionQuantityChange"])
        r_copy["RealizedPnl"] = "0"
        r_copy["Source"] = "CAMS_CAS"
        r_copy["Tags"] = c["Tags"]
        r_copy["Note"] = c["SchemeNote"]
    rows_opt_a.append(r_copy)

fg_a = compute_subaccount_balance(rows_opt_a, "Liquid Mutual Funds", "Fareeda Groww")
fetm_a = compute_subaccount_balance(rows_opt_a, "Liquid Mutual Funds", "Fareeda ETMoney")
ag_a = compute_subaccount_balance(rows_opt_a, "Liquid Mutual Funds", "Ammi Groww")
parent_a = compute_parent_balance(rows_opt_a, "Liquid Mutual Funds")

print("\nWITH OPTION A (TradeValue = Gross Amount, CostBasis = Net Amount):")
print(f"  Fareeda Groww:   Rs. {fg_a} (Diff: {fg_a - fg_cur})")
print(f"  Fareeda ETMoney: Rs. {fetm_a} (Diff: {fetm_a - fetm_cur})")
print(f"  Ammi Groww:      Rs. {ag_a} (Diff: {ag_a - ag_cur})")
print(f"  Parent:          Rs. {parent_a} (Diff: {parent_a - parent_cur})")

