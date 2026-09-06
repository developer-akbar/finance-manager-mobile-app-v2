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

const equityRows = rows.filter(r => (r.Category || '').toLowerCase() === 'equity');
console.log('Total Equity rows in CSV:', equityRows.length);

const subcatTotals = {};
equityRows.forEach(r => {
  const sub = r.Subcategory || '(none)';
  const amt = parseFloat(r.INR || r.Amount || 0);
  subcatTotals[sub] = (subcatTotals[sub] || 0) + amt;
});

console.log('\nEquity Subcategory breakdown in CSV:');
for (const [sub, tot] of Object.entries(subcatTotals)) {
  console.log(`  Subcategory: "${sub}" -> Total: ₹${tot.toFixed(2)} (${tot})`);
}

// Find all rows where subcategory is Zerodha Dividend or note has dividend
const zerodhaDivRows = rows.filter(r => {
  const sub = (r.Subcategory || '').toLowerCase();
  const cat = (r.Category || '').toLowerCase();
  const note = (r.Note || '').toLowerCase();
  return sub.includes('dividend') || (cat === 'equity' && note.includes('dividend'));
});

console.log('\nDividend rows under Equity:');
zerodhaDivRows.forEach(r => {
  console.log(`  Date: ${r.Date} | Cat: ${r.Category} | Sub: ${r.Subcategory} | Note: ${r.Note} | INR: ${r.INR} | Type: ${r['Income/Expense']} | Desc: ${r.Description}`);
});

