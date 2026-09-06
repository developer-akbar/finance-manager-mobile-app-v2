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

console.log('=== FORENSIC CHRONOLOGY SCAN: FEB - APRIL 2018 AROUND THE ₹10,000 TRANSACTIONS ===\n');

// Let's inspect all transactions around the 7 rows:
// 25588 (11/02/2018), 25321 & 25311 (28/02/2018), 25187 (25/03/2018), 25170-25172 (29/03/2018), 25130 (05/04/2018)

const targetRows = [25130, 25170, 25171, 25172, 25187, 25311, 25321, 25588];

targetRows.forEach(r => {
  const t = allTxns[r - 1];
  console.log(`[Row ${r}] Date: ${t.Date} | Type: ${t['Income/Expense'].padEnd(12)} | Amount: ₹${String(t.INR || t.Amount).padStart(8)} | From: ${(t.Account || t.FromAccount || '').padEnd(12)} -> To: ${(t.ToAccount || '').padEnd(10)} | Cat: ${(t.Category || '').padEnd(10)} | Note: "${t.Note}" | Desc: "${t.Description}"`);
});

// Also check surrounding transactions for 25187 (25/03/2018)
console.log('\n--- Surrounding transactions on 25/03/2018 ---');
allTxns.forEach((t, idx) => {
  if (t.Date === '25/03/2018') {
    console.log(`[Row ${idx + 1}] Type: ${t['Income/Expense'].padEnd(12)} | Amount: ₹${String(t.INR || t.Amount).padStart(8)} | From: ${(t.Account || t.FromAccount || '').padEnd(12)} -> To: ${(t.ToAccount || '').padEnd(10)} | Cat: ${(t.Category || '').padEnd(10)} | Note: "${t.Note}" | Desc: "${t.Description}"`);
  }
});

// Check surrounding transactions on 29/03/2018
console.log('\n--- Surrounding transactions on 29/03/2018 ---');
allTxns.forEach((t, idx) => {
  if (t.Date === '29/03/2018') {
    console.log(`[Row ${idx + 1}] Type: ${t['Income/Expense'].padEnd(12)} | Amount: ₹${String(t.INR || t.Amount).padStart(8)} | From: ${(t.Account || t.FromAccount || '').padEnd(12)} -> To: ${(t.ToAccount || '').padEnd(10)} | Cat: ${(t.Category || '').padEnd(10)} | Note: "${t.Note}" | Desc: "${t.Description}"`);
  }
});

// Check surrounding transactions on 05/04/2018
console.log('\n--- Surrounding transactions on 05/04/2018 ---');
allTxns.forEach((t, idx) => {
  if (t.Date === '05/04/2018') {
    console.log(`[Row ${idx + 1}] Type: ${t['Income/Expense'].padEnd(12)} | Amount: ₹${String(t.INR || t.Amount).padStart(8)} | From: ${(t.Account || t.FromAccount || '').padEnd(12)} -> To: ${(t.ToAccount || '').padEnd(10)} | Cat: ${(t.Category || '').padEnd(10)} | Note: "${t.Note}" | Desc: "${t.Description}"`);
  }
});

