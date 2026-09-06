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

// 1. Audit normalized CSV dividends
const normRaw = fs.readFileSync('finman_2026-08-31_Zerodha_final_normalized.csv', 'utf8');
const normRows = parseCSV(normRaw);

const divRows = normRows.filter(r => {
  const note = String(r.Note || '').toLowerCase();
  const desc = String(r.Description || '').toLowerCase();
  const type = String(r.InvestmentTransactionType || '').toUpperCase();
  return note.includes('dividend') || desc.includes('dividend') || type === 'DIVIDEND';
});

console.log(`Total dividend rows in normalized CSV: ${divRows.length}`);
let normDivTotal = 0;
divRows.forEach((r, idx) => {
  const inr = parseFloat(r.INR || r.Amount || r.CashImpact || 0);
  normDivTotal += inr;
  console.log(`  ${idx+1}. Date: ${r.Date} | Symbol: ${r.SecuritySymbol || r.Note} | INR: ${inr} | Acct: ${r.Account || r.FromAccount} -> ${r.ToAccount} | Sub: ${r.SubAccount} | Desc: ${r.Description}`);
});
console.log(`Total Dividend in normalized CSV: ₹${normDivTotal.toFixed(2)}`);

// 2. Audit Statement CSV dividends if present
if (fs.existsSync('scratch/dividends_statement.csv')) {
  console.log('\n=== STATEMENT CSV AUDIT ===');
  const stmtRaw = fs.readFileSync('scratch/dividends_statement.csv', 'utf8');
  const stmtRows = parseCSV(stmtRaw);
  console.log(`Total statement dividend rows: ${stmtRows.length}`);
  let stmtTotal = 0;
  stmtRows.forEach((r, idx) => {
    const amt = parseFloat(r.Amount || r.Net || r['Gross Amount'] || r.INR || r.Dividend || Object.values(r).find(v => !isNaN(parseFloat(v)) && parseFloat(v) > 0) || 0);
    stmtTotal += amt;
    console.log(`  ${idx+1}. `, JSON.stringify(r));
  });
  console.log(`Total Statement Dividend: ₹${stmtTotal.toFixed(2)}`);
}

