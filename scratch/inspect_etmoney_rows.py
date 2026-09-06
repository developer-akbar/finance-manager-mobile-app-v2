import json

with open("scratch/lmf_audit_rows.json", "r", encoding="utf-8") as f:
    rows = json.load(f)

etm_rows = []
for r in rows:
    sub = r["sub"]
    to_sub = r["to_sub"]
    from_sub = r["from_sub"]
    text = f"{sub} {to_sub} {from_sub} {r['brokerage']} {r['note']} {r['desc']}".lower()
    if "etmoney" in text or "et money" in text:
        etm_rows.append(r)

print(f"Total ETMoney rows: {len(etm_rows)}")

# Separate Ak ETMoney vs Fareeda ETMoney
ak_etm = []
fareeda_etm = []

for r in etm_rows:
    desc = r["desc"].lower()
    note = r["note"].lower()
    if "fareeda" in desc or "fareeda" in note or "fareeda" in r["sub"].lower():
        fareeda_etm.append(r)
    else:
        ak_etm.append(r)

print(f"Fareeda ETMoney rows: {len(fareeda_etm)}")
print(f"Ak ETMoney rows: {len(ak_etm)}")

print("\n--- FAREEDA ETMONEY ROWS ---")
for r in fareeda_etm:
    print(f"Line {r['line']:5d} | Date: {r['date']:10s} | Type: {r['type']:12s} | Amt: Rs. {r['amt']:>10.2f} | Note: {r['note'][:30]:30s} | Desc: {r['desc'][:50]:50s} | Sub: {r['sub']}")

print("\n--- AK ETMONEY ROWS (SAMPLE) ---")
for r in ak_etm[:10]:
    print(f"Line {r['line']:5d} | Date: {r['date']:10s} | Type: {r['type']:12s} | Amt: Rs. {r['amt']:>10.2f} | Note: {r['note'][:30]:30s} | Desc: {r['desc'][:50]:50s} | Sub: {r['sub']}")
