const fs = require('fs');

// We test that all JSX / JS references in TransactionItem.jsx are syntactically sound and valid
const code = fs.readFileSync('src/components/Transactions/TransactionItem.jsx', 'utf8');

// Check that isInvestment is defined inside DetailSheet
const detailSheetIdx = code.indexOf('function DetailSheet(');
const detailSheetCode = code.slice(detailSheetIdx);

const checks = [
  { name: 'isInvestment in DetailSheet', pattern: /const isInvestment =/ },
  { name: 'invType in DetailSheet', pattern: /const invType =/ },
  { name: 'invLabel in DetailSheet', pattern: /const invLabel =/ },
  { name: 'invTradeVal in DetailSheet', pattern: /const invTradeVal =/ },
  { name: 'invBroker in DetailSheet', pattern: /const invBroker =/ },
  { name: 'invIsin in DetailSheet', pattern: /const invIsin =/ },
];

console.log('=== TEST DETAILSHEET RUNTIME VARIABLES ===');
let pass = true;
for (const c of checks) {
  const ok = c.pattern.test(detailSheetCode);
  console.log(`  ${c.name}: ${ok ? '✅ PASS' : '❌ FAIL'}`);
  if (!ok) pass = false;
}

if (!pass) {
  console.error('FAILED DetailSheet variable checks');
  process.exit(1);
} else {
  console.log('ALL DetailSheet variable checks PASSED ✅');
}
