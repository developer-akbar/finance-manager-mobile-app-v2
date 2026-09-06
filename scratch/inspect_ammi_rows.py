import json

with open("scratch/lmf_audit_rows.json", "r", encoding="utf-8") as f:
    rows = json.load(f)

# Find all rows matching Ammi
ammi_rows = []
for r in rows:
    text = f"{r['sub']} {r['to_sub']} {r['from_sub']} {r['brokerage']} {r['note']} {r['desc']}".lower()
    if "ammi" in text:
        ammi_rows.append(r)

print(f"Total Ammi rows found: {len(ammi_rows)}")
ammi_rows.sort(key=lambda r: (r['date'].split('/')[::-1]))

total_amt = 0.0
for r in ammi_rows:
    amt = float(r['amt'])
    tt = r['type']
    from_a = r['from']
    to_a = r['to']
    note = r['note']
    desc = r['desc']
    print(f"Line {r['line']:5d} | Date: {r['date']} | Type: {tt:12s} | Amt: Rs. {amt:>10.2f} | Note: {note[:30]:30s} | Desc: {desc[:40]:40s}")
