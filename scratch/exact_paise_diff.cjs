const fs = require('fs');

console.log('=== EXACT PAISE DISCREPANCY RECONCILIATION ===\n');

const userStartingCash = 99991.00; // 9 Canara deposits up to 29-Jul

// User's cash flow sequence:
const userSeq = [
  { name: 'Starting Cash (9 Canara Deposits up to 29-Jul)', amt: 99991.00 },
  { name: 'Indiabulls SELL Net Receipt', amt: 2511.70 },
  { name: 'Lalithaa BUY', amt: -14874.00 },
  { name: 'Lalithaa SELL Net', amt: 19998.03 },
  { name: '31-Aug Deposit (Canara)', amt: 5000.00 },
  { name: '01-Sep Deposit (Canara)', amt: 5000.00 },
  { name: 'DDPI Charge', amt: -118.00 },
  { name: 'Lumino BUY', amt: -14924.00 },
  { name: 'Lumino SELL Net', amt: 20336.34 },
  { name: 'ESDS BUY', amt: -14586.00 },
  { name: 'ESDS SELL Net', amt: 29244.36 }
];

const userTotalCash = userSeq.reduce((s, x) => s + x.amt, 0);
console.log(`User Cash-Flow Statement Total:          ₹${userTotalCash.toFixed(2)}`);

const agCurrentCash = 129559.00;
console.log(`Current FinMan AG Cash Balance:           ₹${agCurrentCash.toFixed(2)}`);
const netDiff = userTotalCash - agCurrentCash;
console.log(`Net Difference (User Statement - AG):     ₹${netDiff.toFixed(2)}\n`);

console.log('--- RECONCILIATION OF INDIVIDUAL DIFFERENCES ---');

const diffs = [
  { item: '1. Active ETF BUY: Gold BeES (25 @ ₹131) [ID: 602c7d6c-e6a7-4411-bb07-6241cdbaa981]', user: 0, csv: -3281.00, diff: -3281.00 },
  { item: '2. Active ETF BUY: SilverBeES (5 @ ₹335) [ID: cf22694f-24ba-4534-becf-eecc645fa497]', user: 0, csv: -1681.00, diff: -1681.00 },
  { item: '3. DDPI Charge (present in user statement, missing in CSV)', user: -118.00, csv: 0, diff: +118.00 },
  { item: '4. ESDS SELL Net Paise Difference (User: 29244.36 vs CSV: 29244.00)', user: 29244.36, csv: 29244.00, diff: +0.36 },
  { item: '5. Lumino SELL Net Paise Difference (User: 20336.34 vs CSV: 20336.00)', user: 20336.34, csv: 20336.00, diff: +0.34 },
  { item: '6. Lalithaa SELL Net Paise Difference (User: 19998.03 vs CSV: 19998.00)', user: 19998.03, csv: 19998.00, diff: +0.03 },
  { item: '7. Indiabulls SELL Net Paise Difference (User: 2511.70 vs CSV: 2512.00)', user: 2511.70, csv: 2512.00, diff: -0.30 }
];

let sumDiffs = 0;
diffs.forEach(d => {
  console.log(`${d.item}:`);
  console.log(`   User: ₹${d.user.toFixed(2)} | CSV: ₹${d.csv.toFixed(2)} | Net Impact on Cash Difference: ₹${(-d.diff).toFixed(2)}`);
  sumDiffs += (-d.diff);
});

console.log(`\nSum of All Itemized Cash Differences:    ₹${sumDiffs.toFixed(2)}`);
console.log(`Expected Difference to Reconcile:        ₹${netDiff.toFixed(2)}`);
console.log(`Reconciliation Residual:                 ₹${(sumDiffs - netDiff).toFixed(2)}`);
