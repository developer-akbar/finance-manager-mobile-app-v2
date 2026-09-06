import csv

CSV_FILE = "finman_2026-09-02.csv"

with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

ak_etmoney_lmf = []
for idx, r in enumerate(rows, 1):
    to_acct = r.get('ToAccount') or ''
    from_acct = r.get('FromAccount') or r.get('Account') or ''
    cat = r.get('Category') or ''
    sub = r.get('SubAccount') or ''
    brokerage = r.get('Brokerage') or ''
    text = f"{sub} {brokerage} {r.get('Note')} {r.get('Description')}".lower()
    
    is_lmf = 'liquid' in f'{to_acct} {from_acct} {cat}'.lower()
    is_ak = 'ak etmoney' in text or 'ak et money' in text
    if is_lmf and is_ak:
        r['_line'] = idx
        ak_etmoney_lmf.append(r)

print('Ak ETMoney in Liquid Mutual Funds count:', len(ak_etmoney_lmf))
for r in ak_etmoney_lmf:
    print(r['_line'], r.get('Date'), r.get('Amount'), r.get('Note'), r.get('Description')[:50])
