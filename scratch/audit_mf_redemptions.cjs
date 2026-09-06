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

console.log('=== REDEMPTION & PROFIT/LOSS TRANSACTIONS AUDIT ===');
const redemptions = txns.filter(t => {
  const note = (t.Note || '').toLowerCase();
  const desc = (t.Description || '').toLowerCase();
  const cat = (t.Category || '').toLowerCase();
  const acct = (t.Account || t.FromAccount || '').toLowerCase();
  const toAcct = (t.ToAccount || '').toLowerCase();

  return (note.includes('redemption') || desc.includes('redemption') || note.includes('equity profit') || note.includes('equity loss') || desc.includes('ltcg')) &&
         (acct.includes('mutual fund') || toAcct.includes('mutual fund') || acct.includes('liquid') || toAcct.includes('liquid') || cat === 'equity' || cat.includes('mutual'));
});

redemptions.forEach(t => {
  console.log(`[${t.Date}] ID=${t.ID.slice(0,8)} | Type=${t['Income/Expense'].padEnd(12)} | From=${(t.FromAccount||t.Account).padEnd(23)} | To=${(t.ToAccount||'').padEnd(10)} | INR=${String(t.INR).padStart(10)} | Cat=${(t.Category||'').padEnd(20)} | Sub=${(t.Subcategory||'').padEnd(16)} | Note=${(t.Note||'').padEnd(35)} | Desc=${t.Description.replace(/\r?\n/g, ' ')}`);
});

