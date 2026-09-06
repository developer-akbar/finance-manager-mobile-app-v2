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

console.log('=== EXACT TAX MF GAINS ROWS IN CSV ===');
const taxMFRows = txns.filter(t => t.Category === 'Equity' && t.Subcategory === 'Tax MF Gains');
let totalTaxGains = 0;
taxMFRows.forEach((r, i) => {
  const amt = parseFloat(r.INR || 0);
  totalTaxGains += amt;
  console.log(`[${i+1}] Date: ${r.Date} | INR: ₹${amt.toFixed(2).padStart(10)} | ID: ${r.ID} | Account: ${r.Account} | Note: ${r.Note} | Desc: ${r.Description.replace(/\r?\n/g, ' ')}`);
});
console.log(`Total Subcategory "Tax MF Gains": ₹${totalTaxGains.toFixed(2)}`);

console.log('\n=== EXACT LIQUID MF LOSSES ROWS IN CSV ===');
const lmfLossRows = txns.filter(t => t.Category === 'Equity' && t.Subcategory === 'Liquid MF Losses');
let totalLmfLosses = 0;
lmfLossRows.forEach((r, i) => {
  const amt = parseFloat(r.INR || 0);
  totalLmfLosses += amt;
  console.log(`[${i+1}] Date: ${r.Date} | INR: ₹${amt.toFixed(2).padStart(10)} | ID: ${r.ID} | Account: ${r.Account} | Note: ${r.Note} | Desc: ${r.Description.replace(/\r?\n/g, ' ')}`);
});
console.log(`Total Subcategory "Liquid MF Losses": ₹${totalLmfLosses.toFixed(2)}`);

console.log('\n=== EXACT LIQUID MF GAINS ROWS IN CSV ===');
const lmfGainRows = txns.filter(t => t.Category === 'Equity' && t.Subcategory === 'Liquid MF Gains');
let totalLmfGains = 0;
lmfGainRows.forEach((r, i) => {
  const amt = parseFloat(r.INR || 0);
  totalLmfGains += amt;
  console.log(`[${i+1}] Date: ${r.Date} | INR: ₹${amt.toFixed(2).padStart(10)} | ID: ${r.ID} | Account: ${r.Account} | Note: ${r.Note} | Desc: ${r.Description.replace(/\r?\n/g, ' ')}`);
});
console.log(`Total Subcategory "Liquid MF Gains": ₹${totalLmfGains.toFixed(2)}`);

console.log('\n=== RECONCILING THE MF P&L NUMBERS ===');
console.log(`Tax MF Gains:         ₹${totalTaxGains.toFixed(2)}`);
console.log(`Liquid MF Gains:      ₹${totalLmfGains.toFixed(2)}`);
console.log(`Liquid MF Losses:     ₹${totalLmfLosses.toFixed(2)}`);
console.log(`Liquid MF Net P&L:    ₹${(totalLmfGains + totalLmfLosses).toFixed(2)}`);
console.log(`Total Net MF P&L:     ₹${(totalTaxGains + totalLmfGains + totalLmfLosses).toFixed(2)}`);

