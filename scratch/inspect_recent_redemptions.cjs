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

const recentRedemptions = txns.filter(t => {
  const d = t.Date || '';
  const isRecent = d.includes('2022') || d.includes('2023') || d.includes('2024') || d.includes('2025') || d.includes('2026');
  const note = (t.Note || '').toLowerCase();
  const desc = (t.Description || '').toLowerCase();
  const cat = (t.Category || '').toLowerCase();
  const acct = (t.Account || t.FromAccount || '').toLowerCase();
  const toAcct = (t.ToAccount || '').toLowerCase();

  return isRecent && (
    (note.includes('redemption') || desc.includes('redemption') || note.includes('profit') || note.includes('loss') || desc.includes('withdrew') || desc.includes('ltcg')) &&
    (acct.includes('mutual fund') || toAcct.includes('mutual fund') || acct.includes('liquid') || toAcct.includes('liquid') || cat === 'equity' || cat.includes('mutual') || note.includes('motilal') || note.includes('tax advantage'))
  );
});

console.log('Recent redemptions & profit/loss entries count:', recentRedemptions.length);
recentRedemptions.forEach(t => {
  console.log(`--------------------------------------------------------------------------------`);
  console.log(`Date: ${t.Date} | Type: ${t['Income/Expense']} | INR: ${t.INR} | Account: ${t.Account} | From: ${t.FromAccount} | To: ${t.ToAccount}`);
  console.log(`Category: ${t.Category} | Subcategory: ${t.Subcategory} | Note: ${t.Note}`);
  console.log(`Description: ${t.Description}`);
});

