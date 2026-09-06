import csv

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

protected_lines = [12110, 12411, 8529, 7931, 8157, 8158, 7894, 7247]
for l in protected_lines:
    r = rows[l - 1]
    print(f"Line {l:>5d} | Date={r.get('Date')} | Amt={float(r.get('Amount') or 0):>8.2f} | InvType='{r.get('InvestmentTransactionType')}' | Note='{r.get('Note')[:30]}' | Sub='{r.get('SubAccount')}'")

# Check ETMoney mixed holding lines 6404 & 6405
r6404 = rows[6404 - 1]
r6405 = rows[6405 - 1]
print(f"Line 6404: Amt={r6404.get('Amount')} | Sub='{r6404.get('SubAccount')}' | Tags='{r6404.get('Tags')}' | InvType='{r6404.get('InvestmentTransactionType')}'")
print(f"Line 6405: Amt={r6405.get('Amount')} | Sub='{r6405.get('SubAccount')}' | Tags='{r6405.get('Tags')}' | InvType='{r6405.get('InvestmentTransactionType')}'")
