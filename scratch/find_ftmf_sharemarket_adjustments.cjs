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

const previewRaw = fs.readFileSync('scratch/finman_CAS_enriched_master_preview_v2.csv', 'utf8');
const allTxns = parseCSV(previewRaw);

console.log('=== CROSS ACCOUNT FTMF / SHARE MARKET ADJUSTMENTS ===\n');

allTxns.forEach((t, idx) => {
  const note = (t.Note || '').toLowerCase();
  const desc = (t.Description || '').toLowerCase();
  const cat = (t.Category || '').toLowerCase();
  const subcat = (t.Subcategory || '').toLowerCase();
  const acct = (t.Account || t.FromAccount || '').toLowerCase();
  const dest = (t.ToAccount || '').toLowerCase();
  const combined = `${note} ${desc} ${cat} ${subcat} ${acct} ${dest}`;

  if (
    (combined.includes('ftmf') && combined.includes('share market')) ||
    (combined.includes('franklin') && combined.includes('share market')) ||
    (combined.includes('liquid') && combined.includes('share market')) ||
    (combined.includes('tax saver') && combined.includes('share market')) ||
    (combined.includes('profit') && combined.includes('loss')) ||
    (combined.includes('compensated') || combined.includes('compensating') || combined.includes('balanced from') || combined.includes('adjusted from'))
  ) {
    console.log(`[Row ${idx + 1}] Date: ${t.Date} | Type: ${t['Income/Expense']} | Amount: ₹${t.INR || t.Amount}`);
    console.log(`  From: ${t.Account || t.FromAccount} -> To: ${t.ToAccount}`);
    console.log(`  Cat: ${t.Category} | SubCat: ${t.Subcategory}`);
    console.log(`  Note: "${t.Note}"`);
    console.log(`  Desc: "${t.Description}"\n`);
  }
});

