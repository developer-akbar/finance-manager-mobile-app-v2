import csv
import json
import re
from collections import defaultdict

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

# 1. First-class investment transactions (with invType BUY or SELL)
fc_txns = []
for idx, r in enumerate(rows, 1):
    inv_type = (r.get("InvestmentTransactionType") or "").strip().upper()
    if inv_type in ["BUY", "SELL", "UNIT_ADJUSTMENT"]:
        r["_line"] = idx
        fc_txns.append(r)

print(f"Total first-class investment transactions across FinMan: {len(fc_txns)}")

# Breakdown of first-class by Account
fc_by_acct = defaultdict(list)
for r in fc_txns:
    inv_a = (r.get("InvestmentAccount") or r.get("ToAccount") or r.get("FromAccount") or r.get("Account") or "").strip()
    fc_by_acct[inv_a].append(r)

for a, t_list in fc_by_acct.items():
    print(f"  Account: {a:<25} : {len(t_list)} txns")

# 2. Check first-class positions by ISIN
fc_positions = defaultdict(lambda: {
    "acct": "",
    "sub": "",
    "isin": "",
    "symbol": "",
    "names": set(),
    "buy_units": 0.0,
    "sell_units": 0.0,
    "buy_tv": 0.0,
    "sell_tv": 0.0,
    "buy_count": 0,
    "sell_count": 0,
    "txns": []
})

for r in fc_txns:
    inv_type = (r.get("InvestmentTransactionType") or "").strip().upper()
    qty = float(r.get("Quantity") or 0)
    tv = float(r.get("TradeValue") or r.get("Amount") or 0)
    isin = (r.get("SecurityISIN") or r.get("ISIN") or "").strip()
    sym = (r.get("SecuritySymbol") or "").strip()
    name = (r.get("SecurityName") or r.get("Note") or "").strip()
    sub = (r.get("SubAccount") or r.get("ToSubAccount") or r.get("FromSubAccount") or "").strip()
    acct = (r.get("InvestmentAccount") or r.get("ToAccount") or r.get("FromAccount") or r.get("Account") or "").strip()
    
    if not isin:
        isin = f"NO_ISIN_{sym or name}"
        
    key = (acct, sub, isin)
    p = fc_positions[key]
    p["acct"] = acct
    p["sub"] = sub
    p["isin"] = isin
    if sym: p["symbol"] = sym
    if name: p["names"].add(name)
    p["txns"].append(r["_line"])
    
    if inv_type in ["BUY", "UNIT_ADJUSTMENT"]:
        p["buy_units"] += qty
        p["buy_tv"] += tv
        p["buy_count"] += 1
    elif inv_type == "SELL":
        p["sell_units"] += qty
        p["sell_tv"] += tv
        p["sell_count"] += 1

print("\n=== FIRST-CLASS MUTUAL FUND POSITIONS ===")
for (acct, sub, isin), p in sorted(fc_positions.items()):
    net_units = p["buy_units"] - p["sell_units"]
    status = "ACTIVE" if net_units > 0.001 else ("REDEEMED" if abs(net_units) <= 0.001 else "DATA ISSUE")
    nm = list(p["names"])[0] if p["names"] else p["symbol"]
    print(f"[{status:<10}] {acct:<24} | Sub: {sub:<15} | ISIN: {isin:<14} | NetUnits: {net_units:>10.3f} | Buys: {p['buy_count']:2d} ({p['buy_units']:>9.3f}) | Sells: {p['sell_count']:2d} ({p['sell_units']:>9.3f}) | Name: {nm}")

