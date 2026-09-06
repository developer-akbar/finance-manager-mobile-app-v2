const fs = require('fs');
const path = require('path');
const { parseCSV } = require('../src/utils/csvParser.js');
const { calculateBrokerageState, parseTxnFields } = require('../src/utils/brokerageAccounting.js');
const { getUnifiedPortfolioData } = require('../src/utils/portfolioSelector.js');

const csvPath = path.join(__dirname, '..', 'finman_2026-09-05.csv');
const rawCsv = fs.readFileSync(csvPath, 'utf8');
const txns = parseCSV(rawCsv);

console.log('=== VERIFICATION OF RESTORED DATASET ===\n');

console.log(`Logical Rows Count: ${txns.length} (Expected: 28891)`);

// 1. Sanity Integrity Verification
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

console.log(`- Duplicate IDs: ${dupIds}`);
console.log(`- Missing IDs: ${missingIds}`);
console.log(`- Malformed Dates: ${malformedDates}`);

// Check 4 replacement IDs presence
const replacementIds = [
  '850da72c-d728-40eb-8e4a-6ea70e3ead7c',
  '5332c24d-477b-4019-978c-2365fc228078',
  '89a16542-fa43-4b90-9ba7-a404f6ce2a97',
  'fcd85e24-0528-412e-87df-dc7430d74650'
];
const repCount = replacementIds.filter(id => ids.has(id)).length;
console.log(`- Correct Replacement IDs Present: ${repCount}/4`);

// Check 4 superseded IDs absence
const supersededIds = [
  '8940a519-5357-4a83-8a35-b118c35b14c1',
  '8279536a-5d7e-49fd-b2cc-ea52207ce9b7',
  'c14a65be-f113-4623-9d88-084751de01d7',
  '8168af65-f56d-4b56-b7f0-b02e7e304113'
];
const superCount = supersededIds.filter(id => ids.has(id)).length;
console.log(`- Superseded Old IDs Present (Expected 0): ${superCount}`);

// 2. Bank Balance Verification (from buildBalanceMap)
function buildBalanceMap(txns) {
  const map = {};
  const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(String(s).trim());
  const addTo = (n, v) => {
    if (n && !looksNumeric(n)) {
      map[n] = (map[n] || 0) + v;
    }
  };

  for (const t of txns) {
    const amt = parseFloat(t.INR || t.inr || t.Amount || t.amount || 0);
    const type = String(t['Income/Expense'] || t.type || '').trim();
    const acct = String(t.Account || '').trim();
    const fromAcct = String(t.FromAccount || t.Account || '').trim();
    const dest = String(t.ToAccount || '').trim();

    if (type === 'Income') {
      addTo(dest || acct, +amt);
    } else if (type === 'Expense') {
      addTo(fromAcct || acct, -amt);
    } else if (type === 'Transfer-Out') {
      addTo(fromAcct, -amt);
      addTo(dest, +amt);
    }
  }
  return map;
}

const ledger = buildBalanceMap(txns);

console.log('\n--- RESTORED BANK BALANCES RECONCILIATION ---');
console.log(`Canara Balance : ₹${ledger['Canara'].toFixed(2)} (Target: ₹434,620)`);
console.log(`HDFC Balance   : ₹${ledger['HDFC'].toFixed(2)} (Target: ₹391,593)`);
console.log(`Lend Balance   : ₹${ledger['Lend'].toFixed(2)} (Target: ₹1,066)`);
console.log(`Stock Balance  : ₹${ledger['Stock'].toFixed(2)} (Target: ₹5,824)`);

// 3. Brokerage Accounting State
const bState = calculateBrokerageState(txns, []);
const fg = bState['Fareeda Groww'];
const z = bState['Zerodha'];

console.log('\n--- BROKERAGE & SHARE MARKET STATE ---');
console.log(`Fareeda Groww Cash Balance: ₹${fg.cashBalance.toFixed(2)}`);
console.log(`Fareeda Groww Total Value : ₹${fg.totalPortfolioValue.toFixed(2)} (Cash ₹${fg.cashBalance.toFixed(2)} + ETFs ₹${fg.investedCost.toFixed(2)})`);
console.log(`Zerodha Total Value       : ₹${z.totalPortfolioValue.toFixed(2)} (Cash ₹${z.cashBalance.toFixed(2)} + Stocks MarketVal ₹${z.currentMarketValue.toFixed(2)})`);
console.log(`Share Market Parent Value : ₹${(fg.totalPortfolioValue + z.totalPortfolioValue).toFixed(2)} (Rounded: ₹${Math.round(fg.totalPortfolioValue + z.totalPortfolioValue).toLocaleString('en-IN')})`);

// 4. Portfolio Data & ETF Verification
const portfolio = getUnifiedPortfolioData(txns);
const activeRedeemedPnl = portfolio.shareMarketPositions.filter(p => p.status === 'REDEEMED');
let closedPnl = 0;
activeRedeemedPnl.forEach(p => { closedPnl += p.realizedPnl; });

console.log('\n--- PORTFOLIO VERIFICATIONS ---');
console.log(`Realized P&L Closed Positions Sum: ₹${closedPnl.toFixed(2)} (Expected: ₹24,530.43)`);
console.log(`Father Mutual Fund Transactions  : ${txns.filter(t => JSON.stringify(t).toLowerCase().includes('father') && (JSON.stringify(t).toLowerCase().includes('mutual') || JSON.stringify(t).toLowerCase().includes('mf'))).length}`);
console.log(`Total Unified Portfolio Positions: ${portfolio.allPositions.length}`);
console.log(`Mutual Fund Positions Count      : ${portfolio.mfPositions.length}`);
console.log(`Share Market Positions Count     : ${portfolio.shareMarketPositions.length}`);

