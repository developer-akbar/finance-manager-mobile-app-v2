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
const rows = parseCSV(raw);

const viseshRows = rows.filter(r => (r.SecuritySymbol || r.Note || '').includes('VISESH') || (r.Description || '').includes('VISESH'));
console.log('VISESHINFO rows count:', viseshRows.length);
viseshRows.forEach(r => console.log(r.InvestmentTransactionType, r.SecuritySymbol, r.Quantity, r.Description));

const tataRows = rows.filter(r => (r.SecuritySymbol || r.Note || '').includes('TATAMTRDVR') || (r.Description || '').includes('TATAMTRDVR'));
console.log('TATAMTRDVR rows count:', tataRows.length);
tataRows.forEach(r => console.log(r.InvestmentTransactionType, r.SecuritySymbol, r.Quantity, r.Description));

