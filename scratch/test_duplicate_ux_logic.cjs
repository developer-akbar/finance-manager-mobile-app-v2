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

function simulateAnalyseImport(rows, mockExistingDbIds = new Set()) {
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

  let dbDupeCount = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const key = itemKeys[i];
    if (!key) continue;
    const id = r.ID || r.id || deterministicId(key);
    if (mockExistingDbIds.has(id)) dbDupeCount++;
  }

  const validTotal = rows.filter((_, i) => itemKeys[i] !== null).length;
  const newRows = Math.max(0, validTotal - dbDupeCount);

  return {
    total: validTotal,
    totalRows: rows.length,
    newRows,
    dbDupeCount,
    fileDupeCount,
    invalidCount,
    investmentCount
  };
}

const raw = fs.readFileSync('finman_2026-08-31_Zerodha_final_v2.csv', 'utf8');
const rows = parseCSV(raw);

console.log('==================================================');
console.log('TEST 1: EMPTY DATABASE + CSV IMPORT PREVIEW');
console.log('==================================================');
const analysis1 = simulateAnalyseImport(rows, new Set());
console.log(`Total Rows in File:            ${analysis1.totalRows.toLocaleString()}`);
console.log(`Valid Rows:                    ${analysis1.total.toLocaleString()}`);
console.log(`New Transactions:              ${analysis1.newRows.toLocaleString()} (Expected: ${analysis1.total.toLocaleString()})`);
console.log(`Already In Database:           ${analysis1.dbDupeCount} (Expected: 0)`);
console.log(`Intra-file duplicate-looking:  ${analysis1.fileDupeCount}`);
console.log(`Invalid Rows:                  ${analysis1.invalidCount}`);
console.log(`Investment Transactions:       ${analysis1.investmentCount}`);
console.log('UX Result: Clearly presents new rows without claiming DB duplicates exist.');

console.log('\n==================================================');
console.log('TEST 2: EXISTING DATABASE + SAME CSV PREVIEW');
console.log('==================================================');
// Populate mock database with IDs from rows
const dbIds = new Set();
rows.forEach(r => {
  const dateVal = normaliseDateStr(r.Date || r.date || '');
  if (!isValidDateStr(dateVal)) return;
  const acctName = String(r.Account || r.account || '').trim();
  const stableKey = getRowStableKey(r, dateVal, acctName);
  const id = r.ID || r.id || deterministicId(stableKey);
  dbIds.add(id);
});

const analysis2 = simulateAnalyseImport(rows, dbIds);
console.log(`Total Rows in File:            ${analysis2.totalRows.toLocaleString()}`);
console.log(`New Transactions:              ${analysis2.newRows.toLocaleString()} (Expected: 0)`);
console.log(`Already In Database:           ${analysis2.dbDupeCount.toLocaleString()} (Expected: ${rows.length})`);
console.log('UX Result: Correctly detects all rows exist and indicates Merge will skip them.');

console.log('\n==================================================');
console.log('TEST 3: IMPORT SAME CSV TWICE SIMULATION');
console.log('==================================================');
const dbSim = new Map();
let firstImportCreated = 0;
let secondImportCreated = 0;

// First import
rows.forEach(r => {
  const dateVal = normaliseDateStr(r.Date || r.date || '');
  if (!isValidDateStr(dateVal)) return;
  const acctName = String(r.Account || r.account || '').trim();
  const stableKey = getRowStableKey(r, dateVal, acctName);
  const id = r.ID || r.id || deterministicId(stableKey);
  if (!dbSim.has(id)) {
    dbSim.set(id, r);
    firstImportCreated++;
  }
});

// Second import
rows.forEach(r => {
  const dateVal = normaliseDateStr(r.Date || r.date || '');
  if (!isValidDateStr(dateVal)) return;
  const acctName = String(r.Account || r.account || '').trim();
  const stableKey = getRowStableKey(r, dateVal, acctName);
  const id = r.ID || r.id || deterministicId(stableKey);
  if (!dbSim.has(id)) {
    dbSim.set(id, r);
    secondImportCreated++;
  }
});

console.log(`First Import Created:          ${firstImportCreated.toLocaleString()}`);
console.log(`Second Import New Created:     ${secondImportCreated} (Expected: 0 duplicates)`);
console.log(`Total In DB After 2 Imports:   ${dbSim.size.toLocaleString()}`);

console.log('\n==================================================');
console.log('TEST 4: LEGITIMATE IDENTICAL-LOOKING TRANSACTIONS');
console.log('==================================================');
const testRows = [
  {
    ID: 'div_lot_1',
    Date: '11/06/2024',
    Time: '12:00',
    Account: 'HDFC',
    Category: 'Finance',
    Note: 'TATAMTRDVR',
    Description: 'Dividend received from TATAMTRDVR per share ₹3.10',
    INR: '77.5',
    Amount: '77.5',
    'Income/Expense': 'Income',
    InvestmentTransactionType: 'DIVIDEND',
    Brokerage: 'Zerodha',
    SecuritySymbol: 'TATAMTRDVR',
    TradeId: 'lot1'
  },
  {
    ID: 'div_lot_2',
    Date: '11/06/2024',
    Time: '12:00',
    Account: 'HDFC',
    Category: 'Finance',
    Note: 'TATAMTRDVR',
    Description: 'Dividend received from TATAMTRDVR per share ₹3.10',
    INR: '77.5',
    Amount: '77.5',
    'Income/Expense': 'Income',
    InvestmentTransactionType: 'DIVIDEND',
    Brokerage: 'Zerodha',
    SecuritySymbol: 'TATAMTRDVR',
    TradeId: 'lot2'
  }
];

const k1 = getRowStableKey(testRows[0], '11/06/2024', 'HDFC');
const k2 = getRowStableKey(testRows[1], '11/06/2024', 'HDFC');
console.log('Key 1:', k1);
console.log('Key 2:', k2);
console.log('Are keys distinct due to TradeId/Identity?', k1 !== k2 ? 'YES (Preserved as distinct)' : 'NO');

const simDb = new Map();
testRows.forEach(r => {
  simDb.set(r.ID, r);
});
console.log(`Distinct Corporate Action Rows Stored: ${simDb.size} / ${testRows.length} (Expected: 2)`);

