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

console.log('=== FORENSIC INVESTIGATION: HISTORICAL LOSS-BALANCING & ADJUSTMENTS ===\n');

const balancingPatterns = [];

allTxns.forEach((t, idx) => {
  const note = (t.Note || '').toLowerCase();
  const desc = (t.Description || '').toLowerCase();
  const cat = (t.Category || '').toLowerCase();
  const subcat = (t.Subcategory || '').toLowerCase();
  const acct = (t.Account || t.FromAccount || '').toLowerCase();
  const dest = (t.ToAccount || '').toLowerCase();
  const combined = `${note} ${desc} ${cat} ${subcat} ${acct} ${dest}`;

  // Find cross-account mentions or explicit balancing
  if (
    (combined.includes('share market') && (combined.includes('ftmf') || combined.includes('franklin') || combined.includes('liquid') || combined.includes('tax saver'))) ||
    combined.includes('adjusted from') ||
    combined.includes('adjusting balance') ||
    combined.includes('adjusted balance') ||
    (note.includes('profit') && (dest.includes('share market') || acct.includes('share market') || dest.includes('liquid') || acct.includes('liquid'))) ||
    (note.includes('loss') && (dest.includes('share market') || acct.includes('share market') || dest.includes('liquid') || acct.includes('liquid'))) ||
    combined.includes('tax mf gains') ||
    combined.includes('liquid mf gains') ||
    combined.includes('liquid mf losses')
  ) {
    balancingPatterns.push({ ...t, _rowIdx: idx + 1 });
  }
});

console.log(`Identified ${balancingPatterns.length} candidate loss-balancing / cross-investment adjustments:`);
balancingPatterns.forEach(t => {
  console.log(`[Row ${t._rowIdx}] Date: ${t.Date} | Type: ${t['Income/Expense']} | Amount: ₹${t.INR || t.Amount} | From: ${t.Account || t.FromAccount} -> To: ${t.ToAccount}`);
  console.log(`  Cat: ${t.Category} | SubCat: ${t.Subcategory} | Note: "${t.Note}" | Desc: "${t.Description}" | InvType: ${t.InvestmentTransactionType || 'none'} | Source: ${t.Source || 'none'}\n`);
});

