const fs = require('fs');
const path = require('path');
const { parseCSV } = require('../src/utils/csvParser.js');
const { rowToTxn } = require('../src/database/transactions.js');

const targetId = 'fa2cad7d-2a8f-461e-8f7b-89dabe912237';

console.log('=== VERIFYING UI DUPLICATION FIX ===\n');

// Simulate getTransactions() behavior with deduplicated Map
const genRows = [
  { id: targetId, account: 'Share Market', sub_account: 'Fareeda Groww', inr: 118, type: 'Expense', note: 'DDPI Charges', date: '31/08/2026' }
];

const invRows = [
  { id: targetId, account: 'Share Market', sub_account: 'Fareeda Groww', brokerage: 'Fareeda Groww', inr: 118, type: 'Expense', note: 'DDPI Charges', date: '31/08/2026' }
];

const txnMap = new Map();
genRows.map(rowToTxn).forEach(t => { if (t._id) txnMap.set(t._id, t); });
invRows.map(rowToTxn).forEach(t => { if (t._id) txnMap.set(t._id, t); });

const txns = Array.from(txnMap.values());

console.log(`Deduplicated getTransactions() results:`);
console.log(`- Array length: ${txns.length} (Expected: 1)`);
console.log(`- Item 1 ID   : ${txns[0]._id}`);
console.log(`- Item 1 Brokerage: "${txns[0].Brokerage}"`);

// Verify all parsed CSV rows (28,890)
const csvPath = path.join(__dirname, '..', 'finman_2026-09-05.csv');
const rawCsv = fs.readFileSync(csvPath, 'utf8');
const parsed = parseCSV(rawCsv);

console.log(`\nParsed CSV rows count: ${parsed.length}`);

const uniqueIds = new Set();
let dupes = 0;
parsed.forEach(t => {
  if (uniqueIds.has(t.ID)) dupes++;
  else uniqueIds.add(t.ID);
});

console.log(`- Unique IDs count: ${uniqueIds.size}`);
console.log(`- Duplicate IDs   : ${dupes}`);
console.log(`- Target ID count in CSV: ${parsed.filter(t => t.ID === targetId).length}`);

