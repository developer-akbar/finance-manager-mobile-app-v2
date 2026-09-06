const fs = require('fs');
const assert = require('assert');
const { parseCSV } = require('../src/utils/csvParser.js');
const { parseMutualFundTransaction } = require('../src/utils/mutualFundPositionEngine.js');

console.log('=== TESTING CSV IMPORT FOR FINMAN_2026-09-05.CSV ===\n');

const csvPath = 'finman_2026-09-05.csv';
const content = fs.readFileSync(csvPath, 'utf8');

// Parse rows using standard app csvParser
const rows = parseCSV(content);
console.log(`- Rows extracted: ${rows.length}`);

// Verify DDPI transaction
const ddpiTxn = rows.find(r => (r.Note || r.note || '').includes('DDPI'));
assert.ok(ddpiTxn, 'DDPI transaction missing from imported rows!');

console.log('- DDPI transaction verified:');
console.log(`  Date: ${ddpiTxn.Date}, Account: ${ddpiTxn.Account}, SubAccount: ${ddpiTxn.SubAccount || ddpiTxn.FromSubAccount}, Type: ${ddpiTxn['Income/Expense']}, Amount: ${ddpiTxn.INR}`);

assert.strictEqual(ddpiTxn.Account, 'Share Market', 'DDPI Account must be Share Market');
assert.strictEqual(ddpiTxn.SubAccount || ddpiTxn.FromSubAccount, 'Fareeda Groww', 'DDPI SubAccount must be Fareeda Groww');
assert.strictEqual(ddpiTxn['Income/Expense'], 'Expense', 'DDPI must be Expense');
assert.strictEqual(parseFloat(ddpiTxn.INR), 118, 'DDPI amount must be 118');

// Verify exact SELL settlement paise
const indiabulls = rows.find(r => (r.Note || '').includes('INDIABULLS') && r.InvestmentTransactionType === 'SELL');
const lalithaa = rows.find(r => (r.Note || '').includes('Lalithaa') && r.InvestmentTransactionType === 'SELL');
const lumino = rows.find(r => (r.Note || '').includes('Lumino') && r.InvestmentTransactionType === 'SELL');
const esds = rows.find(r => (r.Note || '').includes('ESDD') && r.InvestmentTransactionType === 'SELL');

console.log('\n- Exact SELL settlement paise verified:');
console.log(`  Indiabulls SELL net INR: ${indiabulls.INR} (expected 2511.70)`);
console.log(`  Lalithaa SELL net INR: ${lalithaa.INR} (expected 19998.03)`);
console.log(`  Lumino SELL net INR: ${lumino.INR} (expected 20336.34)`);
console.log(`  ESDS SELL net INR: ${esds.INR} (expected 29244.36)`);

assert.strictEqual(parseFloat(indiabulls.INR), 2511.70, 'Indiabulls paise corrupted!');
assert.strictEqual(parseFloat(lalithaa.INR), 19998.03, 'Lalithaa paise corrupted!');
assert.strictEqual(parseFloat(lumino.INR), 20336.34, 'Lumino paise corrupted!');
assert.strictEqual(parseFloat(esds.INR), 29244.36, 'ESDS paise corrupted!');

// Verify generic expense "unknown expenses" ₹386 remains Expense, NOT BUY
const genericExpense = rows.find(r => (r.Note || r.Description || '').includes('unknown expenses'));
assert.ok(genericExpense, 'Generic unknown expenses missing!');
assert.strictEqual(genericExpense['Income/Expense'], 'Expense', 'Generic expense type corrupted!');
assert.strictEqual(genericExpense.InvestmentTransactionType || '', '', 'Generic expense auto-populated as Investment BUY!');

// Verify Father MF records count via Position Engine parser
const fatherMf = rows.filter(r => {
  const p = parseMutualFundTransaction(r);
  return p && p.ownershipTag === 'FATHER_EXTERNAL';
});

console.log(`\n- Father MF records count: ${fatherMf.length} (expected >= 22)`);
assert.ok(fatherMf.length >= 22, 'Father MF records count mismatch!');


console.log('\n✅ ALL CSV IMPORT VERIFICATIONS PASSED SUCCESSFULLY!');
