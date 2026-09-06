import csv
import json
from collections import defaultdict

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

print(f"Total rows in dataset: {len(rows)}")

# Find all mutual fund transactions
# Accounts: Liquid Mutual Funds, Mutual Funds Tax Saver
mf_txns = []
for idx, r in enumerate(rows, 1):
    to_a = (r.get("ToAccount") or "").strip()
    from_a = (r.get("FromAccount") or r.get("Account") or "").strip()
    inv_a = (r.get("InvestmentAccount") or "").strip()
    cat = (r.get("Category") or "").strip()
    
    is_mf = any("liquid mutual fund" in a.lower() or "mutual funds tax saver" in a.lower() for a in [to_a, from_a, inv_a, cat])
    if is_mf:
        r["_line"] = idx
        mf_txns.append(r)

print(f"Total MF transactions found: {len(mf_txns)}")

# Classify transactions
first_class_inv = []
cash_transfers = []
income_expense = []
memos = []

for r in mf_txns:
    inv_type = (r.get("InvestmentTransactionType") or "").strip().upper()
    amt = float(r.get("Amount") or r.get("INR") or 0)
    ttype = (r.get("Income/Expense") or "").strip()
    
    if inv_type in ["BUY", "SELL"]:
        first_class_inv.append(r)
    elif amt == 0:
        memos.append(r)
    elif ttype in ["Income", "Expense"]:
        income_expense.append(r)
    else:
        cash_transfers.append(r)

print(f"First-class investment txns (BUY/SELL): {len(first_class_inv)}")
print(f"Cash transfers (Transfer-Out without invType): {len(cash_transfers)}")
print(f"Income / Expense (P&L / adjustments): {len(income_expense)}")
print(f"Zero-value memos: {len(memos)}")

# Group by Account, SubAccount, ISIN / Security
positions = defaultdict(lambda: {
    "buy_units": 0.0,
    "sell_units": 0.0,
    "buy_trade_val": 0.0,
    "sell_trade_val": 0.0,
    "buy_count": 0,
    "sell_count": 0,
    "txns": [],
    "names": set(),
    "symbols": set(),
    "isin": "",
    "sub": "",
    "acct": ""
})

# Let's see what first-class investment transactions have:
for r in first_class_inv:
    inv_type = (r.get("InvestmentTransactionType") or "").strip().upper()
    qty = float(r.get("Quantity") or 0)
    tv = float(r.get("TradeValue") or r.get("Amount") or 0)
    isin = (r.get("SecurityISIN") or r.get("ISIN") or "").strip()
    sym = (r.get("SecuritySymbol") or "").strip()
    name = (r.get("SecurityName") or r.get("Note") or "").strip()
    sub = (r.get("SubAccount") or r.get("ToSubAccount") or r.get("FromSubAccount") or "").strip()
    acct = (r.get("InvestmentAccount") or r.get("ToAccount") or r.get("FromAccount") or r.get("Account") or "").strip()
    
    key = (acct, sub, isin or name)
    pos = positions[key]
    pos["acct"] = acct
    pos["sub"] = sub
    pos["isin"] = isin
    if name: pos["names"].add(name)
    if sym: pos["symbols"].add(sym)
    pos["txns"].append(r["_line"])
    
    if inv_type == "BUY":
        pos["buy_units"] += qty
        pos["buy_trade_val"] += tv
        pos["buy_count"] += 1
    elif inv_type == "SELL":
        pos["sell_units"] += qty
        pos["sell_trade_val"] += tv
        pos["sell_count"] += 1

print("\n--- FIRST-CLASS INVESTMENT POSITIONS ---")
for key, p in sorted(positions.items()):
    net_units = p["buy_units"] - p["sell_units"]
    status = "ACTIVE" if net_units > 0 else ("REDEEMED" if net_units == 0 else "DATA ISSUE")
    print(f"Acct: {p['acct']:<20} | Sub: {p['sub']:<15} | ISIN: {p['isin']:<14} | NetUnits: {net_units:>10.3f} ({status:<8}) | Buys: {p['buy_count']:2d} ({p['buy_units']:>9.3f}) | Sells: {p['sell_count']:2d} ({p['sell_units']:>9.3f}) | Names: {list(p['names'])[:2]}")

