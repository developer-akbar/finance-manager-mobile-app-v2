import csv

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

# Let's compute parent Liquid Mutual Funds balance exactly as Accounts.jsx computeBalance does
# When subAccountName is null:
# bal = 0
# for t in txns:
#   if t.type === 'Income' and t.FromAccount === acctName: bal += amt
#   if t.type === 'Expense' and t.FromAccount === acctName: bal -= amt
#   if t.type === 'Transfer-Out':
#      if t.FromAccount === acctName: bal -= amt
#      if t.ToAccount === acctName: bal += amt

acct_name = "Liquid Mutual Funds"
total_bal = 0.0
inflows = 0.0
outflows = 0.0
income_amt = 0.0
expense_amt = 0.0

parent_txns = []

for idx, r in enumerate(rows, 1):
    from_a = (r.get("FromAccount") or r.get("Account") or "").strip()
    to_a = (r.get("ToAccount") or "").strip()
    tt = (r.get("Income/Expense") or "").strip()
    amt_str = r.get("Amount") or r.get("INR") or "0"
    amt = float(amt_str) if amt_str else 0.0
    
    touches = False
    delta = 0.0
    
    if tt == "Income" and from_a == acct_name:
        delta = amt
        income_amt += amt
        touches = True
    elif tt == "Expense" and from_a == acct_name:
        delta = -amt
        expense_amt += amt
        touches = True
    elif tt == "Transfer-Out":
        if from_a == acct_name and to_a == acct_name:
            # Internal transfer between subaccounts or self
            delta = 0.0
            touches = True
        elif from_a == acct_name:
            delta = -amt
            outflows += amt
            touches = True
        elif to_a == acct_name:
            delta = amt
            inflows += amt
            touches = True
            
    if touches:
        r["_line"] = idx
        r["_delta"] = delta
        total_bal += delta
        parent_txns.append(r)

print(f"Total transactions touching parent '{acct_name}': {len(parent_txns)}")
print(f"Total Inflows:  Rs. {inflows:,.2f}")
print(f"Total Outflows: Rs. {outflows:,.2f}")
print(f"Total Income:   Rs. {income_amt:,.2f}")
print(f"Total Expense:  Rs. {expense_amt:,.2f}")
print(f"Calculated Parent Balance: Rs. {total_bal:,.2f}")
