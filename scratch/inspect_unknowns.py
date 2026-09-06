import json

with open('scratch/liquid_mf_rows.json', 'r', encoding='utf-8') as f:
    rows = json.load(f)

unknowns = []
for r in rows:
    text = f"{r.get('SubAccount')} {r.get('Note')} {r.get('Description')}".lower()
    if not any(k in text for k in ['etmoney', 'et money', 'ammi', 'fareeda', 'groww']) and r['_match_reason'] not in ['SBI_RD_FD_CREATION', 'FAHIM_POST_OFFICE_MEMO']:
        unknowns.append(r)

print('Count of true unknowns:', len(unknowns))
for u in unknowns[:30]:
    amt = u.get('Amount') or u.get('INR')
    print(f"Line {u['_line']:5d} | {u.get('Date')} | {u.get('Income/Expense')} | Rs. {amt} | From: {u.get('FromAccount') or u.get('Account')} -> To: {u.get('ToAccount')} | Sub: {u.get('SubAccount')} | Note: {u.get('Note')} | Desc: {u.get('Description')[:40]}")
