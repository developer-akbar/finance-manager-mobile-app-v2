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

console.log(`Total Transactions Loaded: ${allTxns.length}`);

// 1. Scan for all investment related terms
const searchKeywords = [
  'share market', 'zerodha', 'groww', 'fareeda', 'ammi', 'liquid mutual fund', 'liquid mf',
  'mutual funds tax saver', 'tax saver', 'tax advantage', 'ftmf', 'franklin',
  'tax mf gains', 'liquid mf gains', 'liquid mf losses', 'zerodha gains', 'zerodha losses',
  'father', 'adjustment', 'adjusted from share market', 'adjusted balance', 'adjusting balance',
  'profit', 'loss', 'redemption', 'dividend', 'investment'
];

const investmentRelated = [];
allTxns.forEach((t, idx) => {
  const acct = (t.Account || '').toLowerCase();
  const fromAcct = (t.FromAccount || '').toLowerCase();
  const toAcct = (t.ToAccount || '').toLowerCase();
  const sub = (t.SubAccount || '').toLowerCase();
  const fromSub = (t.FromSubAccount || '').toLowerCase();
  const toSub = (t.ToSubAccount || '').toLowerCase();
  const cat = (t.Category || '').toLowerCase();
  const subcat = (t.Subcategory || '').toLowerCase();
  const note = (t.Note || '').toLowerCase();
  const desc = (t.Description || '').toLowerCase();
  const tags = (t.Tags || '').toLowerCase();

  const combined = `${acct} ${fromAcct} ${toAcct} ${sub} ${fromSub} ${toSub} ${cat} ${subcat} ${note} ${desc} ${tags}`;
  const isMatch = searchKeywords.some(k => combined.includes(k));
  if (isMatch || t.InvestmentTransactionType || t.SecuritySymbol || t.SecurityISIN || t.Source === 'CAMS_CAS' || t.Source === 'Zerodha') {
    investmentRelated.push({ ...t, _rowIdx: idx + 1 });
  }
});

console.log(`Total Investment-Related Records Identified: ${investmentRelated.length}`);

// 2. Audit FTMF / Franklin records
const franklinTxns = investmentRelated.filter(t => {
  const c = `${t.Account} ${t.FromAccount} ${t.ToAccount} ${t.Note} ${t.Description} ${t.SecuritySymbol}`.toLowerCase();
  return c.includes('ftmf') || c.includes('franklin');
});

console.log(`\n--- FTMF / Franklin Specific Audit (${franklinTxns.length} records) ---`);
const franklinCAS = franklinTxns.filter(t => t.Source === 'CAMS_CAS');
const franklinLegacy = franklinTxns.filter(t => t.Source !== 'CAMS_CAS');

console.log(`- CAS Franklin records: ${franklinCAS.length} (BUY: ${franklinCAS.filter(t => t.InvestmentTransactionType === 'BUY').length}, SELL: ${franklinCAS.filter(t => t.InvestmentTransactionType === 'SELL').length}, ADJ: ${franklinCAS.filter(t => t.InvestmentTransactionType === 'UNIT_ADJUSTMENT').length})`);
console.log(`- Legacy Manual Franklin records: ${franklinLegacy.length}`);
franklinLegacy.forEach(t => {
  console.log(`  [Row ${t._rowIdx}] ${t.Date} | ${t['Income/Expense']} | ₹${t.INR || t.Amount} | From: ${t.Account || t.FromAccount} -> To: ${t.ToAccount} | Note: "${t.Note}" | Desc: "${t.Description}"`);
});

// 3. Audit Father MF / Fareeda Groww + Father records
const fatherTxns = investmentRelated.filter(t => {
  const c = `${t.Account} ${t.FromAccount} ${t.ToAccount} ${t.Note} ${t.Description} ${t.Category} ${t.Subcategory} ${t.SubAccount}`.toLowerCase();
  return c.includes('father');
});
console.log(`\n--- Father Mutual Fund / Father Records (${fatherTxns.length} records) ---`);
fatherTxns.forEach(t => {
  console.log(`  [Row ${t._rowIdx}] ${t.Date} | ${t['Income/Expense']} | ₹${t.INR || t.Amount} | From: ${t.Account || t.FromAccount} -> To: ${t.ToAccount} | Note: "${t.Note}" | Desc: "${t.Description}"`);
});

// 4. Audit Ammi Groww / SBI RD / Family Investment records
const ammiTxns = investmentRelated.filter(t => {
  const c = `${t.Account} ${t.FromAccount} ${t.ToAccount} ${t.Note} ${t.Description} ${t.Category} ${t.Subcategory} ${t.SubAccount}`.toLowerCase();
  return c.includes('ammi') || (c.includes('sbi') && c.includes('rd'));
});
console.log(`\n--- Ammi Groww / Family Investment Records (${ammiTxns.length} records) ---`);
ammiTxns.slice(0, 15).forEach(t => {
  console.log(`  [Row ${t._rowIdx}] ${t.Date} | ${t['Income/Expense']} | ₹${t.INR || t.Amount} | From: ${t.Account || t.FromAccount} -> To: ${t.ToAccount} | Note: "${t.Note}" | Desc: "${t.Description}"`);
});

// 5. Audit "for adjustment" records
const adjTxns = allTxns.filter(t => {
  const c = `${t.Note} ${t.Description}`.toLowerCase();
  return c.includes('for adjustment') || c.includes('adjusted from') || c.includes('adjusting balance') || c.includes('adjusted balance');
});
console.log(`\n--- "For Adjustment" Records (${adjTxns.length} records) ---`);
adjTxns.forEach(t => {
  console.log(`  ${t.Date} | ${t['Income/Expense']} | ₹${t.INR || t.Amount} | From: ${t.Account || t.FromAccount} -> To: ${t.ToAccount} | Note: "${t.Note}" | Desc: "${t.Description}"`);
});

// 6. Audit ₹0 transactions
const zeroTxns = allTxns.filter(t => {
  const amt = parseFloat(t.INR || t.Amount || 0);
  return amt === 0;
});
console.log(`\n--- Total ₹0 Transactions in Master: ${zeroTxns.length} ---`);
const zeroBySource = {};
zeroTxns.forEach(t => {
  const src = t.Source || 'Manual/Legacy';
  const type = t.InvestmentTransactionType || t['Income/Expense'] || 'Unknown';
  const key = `${src} | ${type}`;
  zeroBySource[key] = (zeroBySource[key] || 0) + 1;
});
console.log('Breakdown of ₹0 records:');
console.log(zeroBySource);

// 7. Audit Zerodha Gains, Losses, and PnL balancing
const zerodhaPnlTxns = investmentRelated.filter(t => {
  const c = `${t.Account} ${t.FromAccount} ${t.ToAccount} ${t.Note} ${t.Description} ${t.Category}`.toLowerCase();
  return c.includes('zerodha gains') || c.includes('zerodha losses') || c.includes('stock profit') || c.includes('share market profit') || (c.includes('profit') && c.includes('share market')) || (c.includes('loss') && c.includes('share market'));
});
console.log(`\n--- Zerodha Gains / Losses / PnL Balancing Records (${zerodhaPnlTxns.length} records) ---`);
zerodhaPnlTxns.forEach(t => {
  console.log(`  ${t.Date} | ${t['Income/Expense']} | ₹${t.INR || t.Amount} | From: ${t.Account || t.FromAccount} -> To: ${t.ToAccount} | Note: "${t.Note}" | Desc: "${t.Description}"`);
});

