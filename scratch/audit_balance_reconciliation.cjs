const fs = require('fs');
const path = require('path');
const { parseCSV } = require('../src/utils/csvParser.js');
const { calculateBrokerageState, parseTxnFields } = require('../src/utils/brokerageAccounting.js');

const csvPath = path.join(__dirname, '..', 'finman_2026-09-05.csv');
const rawCsv = fs.readFileSync(csvPath, 'utf8');
const transactions = parseCSV(rawCsv);

console.log('=== FINMAN V2 READ-ONLY ACCOUNT BALANCE AUDIT ===\n');
console.log(`Total CSV Logical Transactions: ${transactions.length}`);

// Helper: build raw ledger balance map (matching buildBalanceMap in Accounts.jsx)
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

// 1. Raw Ledger Balances
const rawLedgerMap = buildBalanceMap(transactions);

console.log('\n--- 1. RAW LEDGER BALANCES (from buildBalanceMap) ---');
Object.keys(rawLedgerMap).sort().forEach(k => {
  console.log(`${k.padEnd(30)}: ₹${rawLedgerMap[k].toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
});

// 2. Brokerage Accounting State
const brokerState = calculateBrokerageState(transactions, []);
console.log('\n--- 2. BROKERAGE ACCOUNTING STATE (from calculateBrokerageState) ---');
Object.keys(brokerState).forEach(b => {
  const s = brokerState[b];
  console.log(`Broker: ${b}`);
  console.log(`  cashBalance         : ₹${s.cashBalance.toFixed(2)}`);
  console.log(`  investedCost        : ₹${s.investedCost.toFixed(2)}`);
  console.log(`  currentMarketValue  : ₹${s.currentMarketValue.toFixed(2)}`);
  console.log(`  totalPortfolioValue : ₹${s.totalPortfolioValue.toFixed(2)}`);
  console.log(`  bankFunding         : ₹${s.bankFunding.toFixed(2)}`);
  console.log(`  bankWithdrawals     : ₹${s.bankWithdrawals.toFixed(2)}`);
  console.log(`  genuineBuyCash      : ₹${s.genuineBuyCash.toFixed(2)}`);
  console.log(`  genuineSellCash     : ₹${s.genuineSellCash.toFixed(2)}`);
  console.log(`  charges             : ₹${s.charges.toFixed(2)}`);
  console.log(`  reconciliationCash  : ₹${s.reconciliationCash.toFixed(2)}`);
  console.log(`  activeHoldings      : ${s.activeHoldings.map(h => `${h.symbol} (${h.qty} units @ ₹${h.currentPrice.toFixed(2)} = ₹${h.currentValue.toFixed(2)})`).join(', ')}`);
});

// 3. UI Display Balances in Accounts.jsx
let totalSmUI = 0;
Object.values(brokerState).forEach(b => {
  totalSmUI += b.totalValue;
});

console.log('\n--- 3. ACCOUNTS.JSX DERIVED DISPLAY BALANCES ---');
console.log(`Raw Ledger 'Share Market' balance : ₹${(rawLedgerMap['Share Market'] || 0).toFixed(2)}`);
console.log(`Accounts.jsx 'Share Market' parent : ₹${totalSmUI.toFixed(2)} (rounded: ₹${Math.round(totalSmUI).toLocaleString('en-IN')})`);
Object.entries(brokerState).forEach(([sub, b]) => {
  console.log(`  Child subaccount '${sub}': Total=₹${b.totalValue.toFixed(2)} (Cash=₹${b.cashBalance.toFixed(2)}, Inv=₹${b.investedCost.toFixed(2)})`);
});
