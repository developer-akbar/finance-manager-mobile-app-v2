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

const normRaw = fs.readFileSync('finman_2026-08-31_Zerodha_final_normalized.csv', 'utf8');
const normRows = parseCSV(normRaw);

const divRows = normRows.filter(r => {
  const note = String(r.Note || '').toLowerCase();
  const desc = String(r.Description || '').toLowerCase();
  const type = String(r.InvestmentTransactionType || '').toUpperCase();
  return note.includes('dividend') || desc.includes('dividend') || type === 'DIVIDEND';
});

console.log('=== DETAILED ANALYSIS OF 39 DIVIDEND ROWS ===');
divRows.forEach((r, idx) => {
  const inr = parseFloat(r.INR || r.Amount || 0);
  const desc = r.Description || '';
  const m = desc.match(/per share ₹([\d.]+)/);
  const rate = m ? parseFloat(m[1]) : null;
  const impliedQty = rate ? (inr / rate).toFixed(2) : 'N/A';
  console.log(`[${idx+1}] ${r.Date} | Symbol: ${r.SecuritySymbol || r.Note} | Amount: ₹${inr} | Rate: ${rate ? '₹' + rate : 'N/A'} | ImpliedQty: ${impliedQty} | Desc: "${desc}"`);
});

// Check where fractional amounts occur in dividends
console.log('\n=== DIVIDENDS WITH FRACTIONAL PAISE (.50, .75, .35, .60, .80) ===');
let sumFractional = 0;
divRows.forEach((r, idx) => {
  const inr = parseFloat(r.INR || r.Amount || 0);
  if (inr % 1 !== 0) {
    console.log(`  Row ${idx+1}: ${r.Date} | ${r.SecuritySymbol || r.Note} | Amount: ₹${inr}`);
    sumFractional += inr;
  }
});
console.log(`Sum of fractional dividends: ₹${sumFractional}`);

