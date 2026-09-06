const fs = require('fs');

function parseCSV(text) {
  if (!text || !text.trim()) return [];
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const records = [];
  let fields = [];
  let field = '';
  let inQ = false;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (inQ) {
      if (ch === '"' && next === '"') {
        field += '"'; i += 2; continue;
      }
      if (ch === '"') {
        inQ = false; i++; continue;
      }
      field += ch; i++; continue;
    }

    if (ch === '"') {
      inQ = true; i++; continue;
    }
    if (ch === ',') {
      fields.push(field); field = ''; i++; continue;
    }
    if (ch === '\n') {
      fields.push(field); field = '';
      records.push(fields); fields = [];
      i++; continue;
    }
    field += ch; i++;
  }
  fields.push(field);
  if (fields.some(f => f !== '')) records.push(fields);

  if (records.length < 2) return [];
  const headers = records[0].map(h => h.trim());
  const rows = [];

  for (let ri = 1; ri < records.length; ri++) {
    const rec = records[ri];
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = (rec[idx] || '').trim();
    });
    if (Object.values(row).every(v => !v)) continue;
    rows.push(row);
  }
  return rows;
}

const casRaw = fs.readFileSync('finman_CAS_MF_redeemed_schemes_2026-08-31_v2.csv', 'utf8');
const casRows = parseCSV(casRaw);

console.log('finman_CAS_MF_redeemed_schemes_2026-08-31_v2.csv rows count:', casRows.length);
console.log('Headers:', Object.keys(casRows[0] || {}).join(', '));

console.log('\n--- SAMPLE CAS ROWS ---');
casRows.slice(0, 10).forEach((r, idx) => {
  console.log(`[${idx+1}] Date=${r.Date} | Type=${r.InvestmentTransactionType} | Scheme=${r.SecuritySymbol || r.SecurityName || r.Description} | ISIN=${r.SecurityISIN} | Folio=${r.FolioNumber || r.Folio} | Units=${r.Quantity} | NAV=${r.UnitPrice || r.NAV} | INR=${r.INR || r.TradeValue} | Acct=${r.Account} | From=${r.FromAccount} | To=${r.ToAccount} | IncExp=${r['Income/Expense']}`);
});

console.log('\n--- BLANK FIELD STATS IN CAS CSV ---');
const stats = {
  total: casRows.length,
  blankAccount: casRows.filter(r => !r.Account).length,
  blankFromAccount: casRows.filter(r => !r.FromAccount).length,
  blankToAccount: casRows.filter(r => !r.ToAccount).length,
  blankIncomeExpense: casRows.filter(r => !r['Income/Expense']).length,
  blankDate: casRows.filter(r => !r.Date).length,
  blankISIN: casRows.filter(r => !r.SecurityISIN).length,
  blankQuantity: casRows.filter(r => !r.Quantity).length,
  blankUnitPrice: casRows.filter(r => !r.UnitPrice).length,
  blankTradeValue: casRows.filter(r => !r.TradeValue && !r.INR).length,
  types: {}
};
casRows.forEach(r => {
  const t = r.InvestmentTransactionType || '(blank)';
  stats.types[t] = (stats.types[t] || 0) + 1;
});

console.log(JSON.stringify(stats, null, 2));

