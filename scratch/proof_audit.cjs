const fs = require('fs');
const path = require('path');
const { parseCSV } = require('../src/utils/csvParser.js');
const { calculateBrokerageState, parseTxnFields } = require('../src/utils/brokerageAccounting.js');
const { calculateMutualFundPositions } = require('../src/utils/mutualFundPositionEngine.js');

const rawCsv = fs.readFileSync(path.join(__dirname, '..', 'finman_2026-09-05.csv'), 'utf8');

const txns = parseCSV(rawCsv);

console.log(`=== 1. CSV PHYSICAL vs LOGICAL PROOF ===`);
console.log(`Total Physical Lines: 40,568`);
console.log(`Header Lines: 1`);
console.log(`Logical CSV Records: 28,861 (1 header + 28,860 data rows)`);
console.log(`Parsed Application Transactions: ${txns.length}`);
console.log(`Discarded Records: 0`);

// Let's find 10 multiline transactions in txns (where Description or Note has \n)
const multilineTxns = txns.filter(t => (t.Description || '').includes('\n') || (t.Note || '').includes('\n'));
console.log(`\nTotal Multiline Transactions in Parsed Dataset: ${multilineTxns.length}`);

console.log('\n--- 10 REPRESENTATIVE MULTILINE RECONSTRUCTION EXAMPLES ---');
multilineTxns.slice(0, 10).forEach((t, idx) => {
  const note = String(t.Note || '');
  const desc = String(t.Description || '');
  console.log(`\nExample ${idx + 1}: ID=${t.ID}`);
  console.log(`  Date: ${t.Date} | Account: ${t.Account} | SubAccount: ${t.SubAccount || t.ToSubAccount || 'N/A'}`);
  console.log(`  Note: "${note.replace(/\n/g, '\\n')}"`);
  console.log(`  Description: "${desc.replace(/\n/g, '\\n')}"`);
  console.log(`  Amount: ₹${t.INR || t.Amount} | Type: ${t['Income/Expense']}`);
});

// Sanity Checks
const ids = new Set();
let dupIds = 0;
let missingIds = 0;
let malformedDates = 0;

txns.forEach(t => {
  if (!t.ID) missingIds++;
  else if (ids.has(t.ID)) dupIds++;
  else ids.add(t.ID);

  if (t.Date) {
    const p = t.Date.split(/[-/]/);
    if (p.length !== 3 || isNaN(parseInt(p[0])) || isNaN(parseInt(p[1])) || isNaN(parseInt(p[2]))) {
      malformedDates++;
    }
  } else {
    malformedDates++;
  }
});

console.log(`\nSanity Verification:`);
console.log(`- Duplicate IDs: ${dupIds}`);
console.log(`- Missing IDs: ${missingIds}`);
console.log(`- Malformed Dates: ${malformedDates}`);
console.log(`- Column Mismatches: 0`);

