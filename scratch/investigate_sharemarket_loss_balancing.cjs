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

console.log('=== FORENSIC DEEP DIVE: 2018 SHARE MARKET LOSSES & BALANCING TRANSFERS ===\n');

// 1. Inspect all 2018 Share Market transactions (Feb 2018 to April 2018)
const sm2018 = [];
allTxns.forEach((t, idx) => {
  const acct = t.Account || t.FromAccount || '';
  const dest = t.ToAccount || '';
  const c = `${t.Account} ${t.FromAccount} ${t.ToAccount} ${t.Note} ${t.Description} ${t.Category} ${t.Subcategory}`.toLowerCase();
  
  if (c.includes('share market') || c.includes('zerodha') || c.includes('ashokley') || c.includes('indiacem')) {
    const d = t.Date;
    if (d && (d.includes('2018') || d.includes('/18'))) {
      sm2018.push({ ...t, _row: idx + 1 });
    }
  }
});

console.log(`Found ${sm2018.length} Share Market / Equity records in 2018.\n`);

// Group by Date and Category
const byDate = {};
sm2018.forEach(t => {
  if (!byDate[t.Date]) byDate[t.Date] = [];
  byDate[t.Date].push(t);
});

console.log('--- 2018 SHARE MARKET TRANSACTIONS BY DATE ---');
Object.keys(byDate).sort().forEach(date => {
  console.log(`\nDate: ${date} (${byDate[date].length} txns)`);
  let netPnl = 0;
  byDate[date].forEach(t => {
    const amt = parseFloat(t.INR || t.Amount || 0);
    const type = t['Income/Expense'];
    const pnl = type === 'Income' ? amt : (type === 'Expense' ? -amt : 0);
    netPnl += pnl;
    console.log(`  [Row ${t._row}] ${t['Income/Expense'].padEnd(12)} | ₹${String(t.INR || t.Amount).padStart(8)} | From: ${(t.Account || t.FromAccount).padEnd(15)} -> To: ${(t.ToAccount || '').padEnd(10)} | Note: "${t.Note}" | Desc: "${t.Description}"`);
  });
  console.log(`  => Day Net P&L / Flow: ₹${netPnl.toFixed(2)}`);
});

// 2. Scan all other candidate balancing terms across the whole dataset
console.log('\n--- SCAN FOR ANY OTHER HISTORICAL MF / SHARE MARKET BALANCING TRANSACTIONS ---');
const candidateTerms = [
  'from share market', 'adjusted from share market', 'adjusted balance', 'adjusting balance',
  'ftmf', 'mutual fund profit', 'mutual fund loss', 'share market loss', 'share market profit',
  'recovered from', 'balance adjusted'
];

const otherBalancing = [];
allTxns.forEach((t, idx) => {
  const note = (t.Note || '').toLowerCase();
  const desc = (t.Description || '').toLowerCase();
  const cat = (t.Category || '').toLowerCase();
  const subcat = (t.Subcategory || '').toLowerCase();
  const c = `${note} ${desc} ${cat} ${subcat}`;

  for (const term of candidateTerms) {
    if (c.includes(term)) {
      otherBalancing.push({ ...t, _row: idx + 1, _matchedTerm: term });
      break;
    }
  }
});

console.log(`Total matched records across entire dataset: ${otherBalancing.length}`);
const nonStandardBalancing = otherBalancing.filter(t => {
  const note = (t.Note || '').toLowerCase();
  const desc = (t.Description || '').toLowerCase();
  const isOneOf6 = t._row === 25130 || t._row === 25170 || t._row === 25172 || t._row === 25187 || t._row === 25321 || t._row === 25588;
  const isZerodhaPnl = note.includes('zerodha gains') || note.includes('zerodha losses') || desc.includes('realized profit on sale') || desc.includes('realized loss on sale');
  const isCas = t.Source === 'CAMS_CAS';
  return !isOneOf6 && !isZerodhaPnl && !isCas;
});

console.log(`\nNon-Standard / Potential Other Manual Balancing Records (${nonStandardBalancing.length}):`);
nonStandardBalancing.forEach(t => {
  console.log(`[Row ${t._row}] Date: ${t.Date} | ₹${t.INR || t.Amount} | From: ${t.Account || t.FromAccount} -> To: ${t.ToAccount} | Note: "${t.Note}" | Desc: "${t.Description}"`);
});

