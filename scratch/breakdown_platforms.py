import json

with open("scratch/lmf_audit_rows.json", "r", encoding="utf-8") as f:
    rows = json.load(f)

print(f"Total rows: {len(rows)}")

platform_breakdown = {}
for r in rows:
    sub = r["sub"]
    to_sub = r["to_sub"]
    from_sub = r["from_sub"]
    text = f"{sub} {to_sub} {from_sub} {r['brokerage']} {r['note']} {r['desc']}".lower()
    
    # Check platform
    if "etmoney" in text or "et money" in text:
        plat = "Fareeda ETMoney"
    elif "ammi" in text:
        plat = "Ammi Groww"
    elif "fareeda" in text or "groww" in text:
        plat = "Fareeda Groww"
    elif r["line"] == 12110 or r["line"] == 12411:
        plat = "FD/RD Money Trail (SBI RD / Fahim Post Office)"
    elif "nippon india liquid" in text or "franklin india ultra" in text or "kotak nifty next 50" in text or "nippon india nifty midcap 150" in text:
        plat = "Ak ETMoney"
    else:
        plat = "Unclassified / Need Investigation"
        
    platform_breakdown[plat] = platform_breakdown.get(plat, 0) + 1

print("\nPlatform Breakdown:")
for p, c in sorted(platform_breakdown.items()):
    print(f"  {p}: {c} rows")
