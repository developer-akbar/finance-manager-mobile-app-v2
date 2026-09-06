const fs = require('fs');
const { getRowStableKey } = require('../src/database/transactions.js');

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

const normaliseDateStr = (raw) => {
  const s = String(raw || '').trim();
  if (!s) return '';
  const dmy = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (dmy) {
    return String(parseInt(dmy[1])).padStart(2, '0') + '/' +
           String(parseInt(dmy[2])).padStart(2, '0') + '/' +
           dmy[3];
  }
  const ymd = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (ymd) {
    return String(parseInt(ymd[3])).padStart(2, '0') + '/' +
           String(parseInt(ymd[2])).padStart(2, '0') + '/' +
           ymd[1];
  }
  return s;
};

const isValidDateStr = (s) => /^\d{2}\/\d{2}\/\d{4}$/.test(String(s||'').trim());

function deterministicId(key) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    const ch = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (h2 >>> 0) + (h1 >>> 0);
  return 'txn-' + n.toString(36).padStart(12, '0');
}

const raw = fs.readFileSync('finman_2026-08-31_Zerodha_final_v2.csv', 'utf8');
const rows = parseCSV(raw);

// Simulate full import on empty DB
const seenKeys = new Map();
const itemKeys = [];
let invalidCount = 0;
let investmentCount = 0;

for (const r of rows) {
  const rawDate = r.Date || r.date || '';
  const dateVal = normaliseDateStr(rawDate);
  if (!isValidDateStr(dateVal)) {
    itemKeys.push(null);
    invalidCount++;
    continue;
  }
  const isInv = !!(r.InvestmentTransactionType || r.Brokerage);
  if (isInv) investmentCount++;

  const rawAcct = String(r.Account || r.account || '').trim();
  const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(s);
  const acctName = looksNumeric(rawAcct)
    ? String(r.FromAccount || r.from_account || rawAcct).trim()
    : rawAcct;

  const stableKey = getRowStableKey(r, dateVal, acctName);
  itemKeys.push(stableKey);
  seenKeys.set(stableKey, (seenKeys.get(stableKey) || 0) + 1);
}

const fileDupeKeys = new Set([...seenKeys.entries()].filter(([, v]) => v > 1).map(([k]) => k));
const fileDupeCount = itemKeys.filter(k => k && fileDupeKeys.has(k)).length;

// Simulate bulkImport execution (INSERT OR IGNORE into SQLite map)
const dbStore = new Map();
let importedCount = 0;
let skippedCount = 0;

for (const r of rows) {
  const rawDate = r.Date || r.date || '';
  const dateVal = normaliseDateStr(rawDate);
  if (!isValidDateStr(dateVal)) {
    skippedCount++;
    continue;
  }
  const rawAcct = String(r.Account || r.account || '').trim();
  const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(s);
  const acctName = looksNumeric(rawAcct)
    ? String(r.FromAccount || r.from_account || rawAcct).trim()
    : rawAcct;

  const stableKey = getRowStableKey(r, dateVal, acctName);
  const id = r.ID || r.id || deterministicId(stableKey);

  if (!dbStore.has(id)) {
    dbStore.set(id, r);
    importedCount++;
  } else {
    skippedCount++;
  }
}

console.log('==================================================');
console.log('CSV IMPORT STATS REPORT');
console.log('==================================================');
console.log(`Total Rows in CSV:             ${rows.length.toLocaleString()}`);
console.log(`New Rows Ready for Import:     ${(rows.length - 0).toLocaleString()}`);
console.log(`Database Duplicates:           0 (Clean Database)`);
console.log(`Possible Within-File Duplicates: ${fileDupeCount} (Informational signature warning only)`);
console.log(`Skipped Rows:                  ${skippedCount}`);
console.log(`Imported Rows:                 ${importedCount.toLocaleString()}`);
console.log(`Stored Rows in Database:       ${dbStore.size.toLocaleString()}`);

// Audit the 40 dividend records in the imported database
const importedRows = Array.from(dbStore.values());
const divRows = importedRows.filter(r => {
  const note = String(r.Note || '').toLowerCase();
  const desc = String(r.Description || '').toLowerCase();
  const type = String(r.InvestmentTransactionType || '').toUpperCase();
  return note.includes('dividend') || desc.includes('dividend') || type === 'DIVIDEND';
});

let totalDivAmt = 0;
divRows.forEach(r => {
  totalDivAmt += parseFloat(r.INR || r.Amount || 0);
});

console.log('\n==================================================');
console.log('DIVIDEND INTEGRITY CHECK AFTER IMPORT');
console.log('==================================================');
console.log(`Imported Dividend Records Count: ${divRows.length} (Expected: 40)`);
console.log(`Total Imported Dividend Sum:    ₹${totalDivAmt.toFixed(2)} (Expected: ₹2,178.55)`);

// Check repeated TATAMTRDVR dividend records on 11/06/2024
const tatadivs = divRows.filter(r => (r.SecuritySymbol || r.Note || '').includes('TATAMTRDVR'));
console.log(`TATAMTRDVR Dividend Records Count: ${tatadivs.length} (Expected: 3 records including the two on 11/06/2024)`);
tatadivs.forEach((r, idx) => {
  console.log(`  [${idx+1}] ID: ${r.ID} | Date: ${r.Date} | INR: ₹${r.INR} | Note: ${r.Note} | Desc: ${r.Description}`);
});

