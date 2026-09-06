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

const raw = fs.readFileSync('finman_2026-08-31_Zerodha_final_v2.csv', 'utf8');
const txns = parseCSV(raw);

const invTxns = txns.filter(t => t.InvestmentTransactionType || t.Brokerage);
console.log('Total Zerodha / Investment rows:', invTxns.length);

const types = {};
invTxns.forEach(t => {
  const type = t.InvestmentTransactionType || '(blank)';
  types[type] = (types[type] || 0) + 1;
});
console.log('Investment Types:', types);

console.log('\n--- SAMPLE BUY TRANSACTION ---');
const buySample = invTxns.find(t => t.InvestmentTransactionType === 'BUY');
console.log(JSON.stringify(buySample, null, 2));

console.log('\n--- SAMPLE SELL TRANSACTION ---');
const sellSample = invTxns.find(t => t.InvestmentTransactionType === 'SELL');
console.log(JSON.stringify(sellSample, null, 2));

console.log('\n--- SAMPLE DIVIDEND TRANSACTION ---');
const divSample = invTxns.find(t => t.InvestmentTransactionType === 'DIVIDEND');
console.log(JSON.stringify(divSample, null, 2));

console.log('\n--- SAMPLE BANK FUNDING TRANSFER FOR ZERODHA ---');
const fundSample = txns.find(t => (t.ToAccount === 'Share Market' || t.Account === 'Share Market') && t['Income/Expense'] === 'Transfer-Out');
console.log(JSON.stringify(fundSample, null, 2));

