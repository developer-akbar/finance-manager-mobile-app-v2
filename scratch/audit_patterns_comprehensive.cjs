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

console.log('=== COMPREHENSIVE FORENSIC AUDIT: PATTERNS & STATS ===\n');

// 1. Father Mutual Fund / Fareeda Groww + Father
const fatherRecords = [];
allTxns.forEach((t, idx) => {
  const c = `${t.Account} ${t.FromAccount} ${t.ToAccount} ${t.Note} ${t.Description} ${t.Category} ${t.Subcategory} ${t.SubAccount}`.toLowerCase();
  if (c.includes('father mutual fund') || c.includes('father mf') || (c.includes('father') && c.includes('mutual fund')) || (c.includes('father') && c.includes('groww'))) {
    fatherRecords.push({ ...t, _rowIdx: idx + 1 });
  }
});

console.log(`1. Father Mutual Fund Records: ${fatherRecords.length}`);
let fatherZeroCount = 0, fatherUserPaidCount = 0, fatherCashCount = 0;
let fatherUserPaidAmt = 0, fatherCashAmt = 0;

fatherRecords.forEach(t => {
  const amt = parseFloat(t.INR || t.Amount || 0);
  const note = (t.Note || '').toLowerCase();
  const desc = (t.Description || '').toLowerCase();
  const isZero = amt === 0;

  if (isZero) {
    fatherZeroCount++;
  } else if (desc.includes('i paid') || desc.includes('paid by me') || desc.includes('my payment') || (t.Account || t.FromAccount) === 'HDFC' || (t.Account || t.FromAccount) === 'SBI') {
    fatherUserPaidCount++;
    fatherUserPaidAmt += amt;
  } else {
    fatherCashCount++;
    fatherCashAmt += amt;
  }
});
console.log(`  - ₹0 Tracking-only:       ${fatherZeroCount} txns`);
console.log(`  - User-Funded Investment: ${fatherUserPaidCount} txns (₹${fatherUserPaidAmt.toFixed(2)})`);
console.log(`  - Direct Father Funds:    ${fatherCashCount} txns (₹${fatherCashAmt.toFixed(2)})\n`);

// 2. Ammi Groww / SBI RD / Family
const ammiRecords = [];
allTxns.forEach((t, idx) => {
  const c = `${t.Account} ${t.FromAccount} ${t.ToAccount} ${t.Note} ${t.Description} ${t.Category} ${t.Subcategory} ${t.SubAccount}`.toLowerCase();
  if (c.includes('ammi groww') || (c.includes('ammi') && c.includes('groww')) || (c.includes('ammi') && c.includes('investment'))) {
    ammiRecords.push({ ...t, _rowIdx: idx + 1 });
  }
});
console.log(`2. Ammi Groww / Family Investment Records: ${ammiRecords.length}`);
let ammiZeroCount = 0, ammiSbiRdCount = 0, ammiOtherCount = 0;
let ammiSbiRdAmt = 0, ammiOtherAmt = 0;

ammiRecords.forEach(t => {
  const amt = parseFloat(t.INR || t.Amount || 0);
  const desc = (t.Description || '').toLowerCase();
  const note = (t.Note || '').toLowerCase();

  if (amt === 0) {
    ammiZeroCount++;
  } else if (desc.includes('rd') || desc.includes('sbi') || note.includes('rd') || (t.Account || t.FromAccount) === 'SBI') {
    ammiSbiRdCount++;
    ammiSbiRdAmt += amt;
  } else {
    ammiOtherCount++;
    ammiOtherAmt += amt;
  }
});
console.log(`  - ₹0 Tracking-only: ${ammiZeroCount} txns`);
console.log(`  - SBI RD / Bank -> Ammi Groww: ${ammiSbiRdCount} txns (₹${ammiSbiRdAmt.toFixed(2)})`);
console.log(`  - Other Ammi Groww: ${ammiOtherCount} txns (₹${ammiOtherAmt.toFixed(2)})\n`);

// 3. "For Adjustment" Analysis
const adjAll = [];
allTxns.forEach((t, idx) => {
  const note = (t.Note || '').toLowerCase();
  const desc = (t.Description || '').toLowerCase();
  if (note.includes('for adjustment') || desc.includes('for adjustment') || note === 'adjustment' || desc === 'adjustment') {
    adjAll.push({ ...t, _rowIdx: idx + 1 });
  }
});
console.log(`3. "For Adjustment" Records: ${adjAll.length}`);
const adjCategories = {};
adjAll.forEach(t => {
  const cat = t.Category || 'Uncategorized';
  adjCategories[cat] = (adjCategories[cat] || 0) + 1;
});
console.log('  Categories breakdown:', adjCategories);

// 4. ₹0 Transactions Detailed Scan
const zeroAll = [];
allTxns.forEach((t, idx) => {
  const amt = parseFloat(t.INR || t.Amount || 0);
  if (amt === 0) {
    zeroAll.push({ ...t, _rowIdx: idx + 1 });
  }
});
console.log(`\n4. ₹0 Transactions Scan (Total ${zeroAll.length} records):`);

const zeroTypes = {
  casUnitAdj: 0,
  zerodhaLegitZero: 0,
  familyTracking: 0,
  otherManualZero: 0
};

zeroAll.forEach(t => {
  if (t.InvestmentTransactionType === 'UNIT_ADJUSTMENT' && t.Source === 'CAMS_CAS') {
    zeroTypes.casUnitAdj++;
  } else if (t.Source === 'Zerodha' || t.InvestmentTransactionType === 'RECONCILIATION') {
    zeroTypes.zerodhaLegitZero++;
  } else {
    const c = `${t.Note} ${t.Description} ${t.Category} ${t.Subcategory}`.toLowerCase();
    if (c.includes('father') || c.includes('ammi') || c.includes('fareeda') || c.includes('family')) {
      zeroTypes.familyTracking++;
    } else {
      zeroTypes.otherManualZero++;
    }
  }
});
console.log('  Breakdown:', zeroTypes);

