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

console.log('=== SECOND FORENSIC AUDIT: OWNER MODEL & RECONCILIATION ===\n');

// 1. Resolve 14 vs 6 discrepancy
const allAdjustments = [];
allTxns.forEach((t, idx) => {
  const note = (t.Note || '').toLowerCase();
  const desc = (t.Description || '').toLowerCase();
  const c = `${note} ${desc}`;
  if (c.includes('adjusted from share market') || c.includes('adjusting balance') || c.includes('adjusted balance') || c.includes('profit on muvar mobile')) {
    allAdjustments.push({ ...t, _row: idx + 1 });
  }
});

console.log(`--- 1. RESOLUTION OF 14 vs 6 DISCREPANCY (${allAdjustments.length} candidate adjustments) ---`);
allAdjustments.forEach(t => {
  console.log(`[Row ${t._row}] Date: ${t.Date} | ₹${t.INR || t.Amount} | From: ${t.Account || t.FromAccount} -> To: ${t.ToAccount} | Note: "${t.Note}" | Desc: "${t.Description}"`);
});

// 2. Fareeda Groww audit
const fareedaTxns = allTxns.filter((t, idx) => {
  const c = `${t.Account} ${t.FromAccount} ${t.ToAccount} ${t.SubAccount} ${t.FromSubAccount} ${t.ToSubAccount} ${t.Note} ${t.Description}`.toLowerCase();
  return c.includes('fareeda groww') || (c.includes('fareeda') && c.includes('groww'));
});

console.log(`\n--- 2. FAREEDA GROWW COMPLETE AUDIT (${fareedaTxns.length} records) ---`);
let fgCashIn = 0, fgCashOut = 0, fgZero = 0, fgFather = 0, fgOther = 0;
fareedaTxns.forEach(t => {
  const amt = parseFloat(t.INR || t.Amount || 0);
  const c = `${t.Note} ${t.Description}`.toLowerCase();
  if (c.includes('father')) {
    fgFather++;
  } else if (amt === 0) {
    fgZero++;
  } else if (t['Income/Expense'] === 'Transfer-Out' || t['Income/Expense'] === 'Expense') {
    const dest = t.ToAccount;
    if (dest === 'Liquid Mutual Funds' || dest === 'Share Market') fgCashIn += amt;
    else fgCashOut += amt;
  } else {
    fgOther++;
  }
});
console.log(`- Total Records: ${fareedaTxns.length}`);
console.log(`  - Father MF Memos inside Fareeda Groww: ${fgFather}`);
console.log(`  - ₹0 Tracking records: ${fgZero}`);
console.log(`  - Net Cash Inflows into Fareeda Groww: ₹${fgCashIn.toFixed(2)}`);
console.log(`  - Net Cash Outflows from Fareeda Groww: ₹${fgCashOut.toFixed(2)}`);

// 3. Ammi Groww complete audit
const ammiTxns = allTxns.filter((t, idx) => {
  const c = `${t.Account} ${t.FromAccount} ${t.ToAccount} ${t.SubAccount} ${t.FromSubAccount} ${t.ToSubAccount} ${t.Note} ${t.Description}`.toLowerCase();
  return c.includes('ammi groww') || (c.includes('ammi') && c.includes('groww'));
});

console.log(`\n--- 3. AMMI GROWW COMPLETE AUDIT (${ammiTxns.length} records) ---`);
ammiTxns.forEach((t, idx) => {
  console.log(`[#${idx + 1}] Date: ${t.Date} | ₹${t.INR || t.Amount} | From: ${t.Account || t.FromAccount} -> To: ${t.ToAccount} | Note: "${t.Note}" | Desc: "${t.Description}"`);
});

// 4. Father MF Isolation
const fatherTxns = allTxns.filter((t, idx) => {
  const c = `${t.Account} ${t.FromAccount} ${t.ToAccount} ${t.Note} ${t.Description} ${t.Category}`.toLowerCase();
  return c.includes('father mutual fund') || c.includes('father mf') || (c.includes('father') && c.includes('mutual fund'));
});
console.log(`\n--- 4. FATHER MUTUAL FUND ISOLATION (${fatherTxns.length} records) ---`);
fatherTxns.forEach((t, idx) => {
  console.log(`[#${idx + 1}] Date: ${t.Date} | ₹${t.INR || t.Amount} | From: ${t.Account || t.FromAccount} -> To: ${t.ToAccount} | Note: "${t.Note}" | Desc: "${t.Description}"`);
});

