import csv
from simulate_normalization import resolve_subaccount

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

for r in rows:
    if r.get("ID") == "c24bc7db-14f6-4e3d-8752-f5a243d48d45":
        r["SubAccount"] = "Ammi Groww"
        amt = float(r.get("Amount") or 0)
        ttype = r.get("Income/Expense")
        from_acct = r.get("FromAccount") or r.get("Account") or ""
        dest = r.get("ToAccount") or ""
        sub = r.get("SubAccount") or ""
        from_sub = r.get("FromSubAccount") or ""
        to_sub = r.get("ToSubAccount") or ""
        
        is_dest_inv = dest in ["Mutual Funds Tax Saver", "Liquid Mutual Funds", "Share Market"]
        resolved_to_sub = to_sub if (to_sub and to_sub != "Default") else (resolve_subaccount(r, dest) if is_dest_inv else (sub if (sub and sub != "Default") else ""))
        
        print(f"Row 6125:")
        print(f"  amt: {amt}")
        print(f"  ttype: {ttype}")
        print(f"  from_acct: {from_acct}")
        print(f"  dest: {dest}")
        print(f"  sub: {sub}")
        print(f"  to_sub: {to_sub}")
        print(f"  is_dest_inv: {is_dest_inv}")
        print(f"  resolve_subaccount(r, dest): {resolve_subaccount(r, dest)}")
        print(f"  resolved_to_sub: {resolved_to_sub}")
