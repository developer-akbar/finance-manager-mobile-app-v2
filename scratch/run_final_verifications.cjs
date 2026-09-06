const fs = require('fs');
const path = require('path');
const { parseCSV } = require('../src/utils/csvParser.js');
const { calculateBrokerageState } = require('../src/utils/brokerageAccounting.js');

const rawCsv = fs.readFileSync(path.join(__dirname, '..', 'finman_2026-09-05.csv'), 'utf8');
const txns = parseCSV(rawCsv);

console.log('=== DETAILED VERIFICATION FOR FINAL REPORT ===\n');

// Inline ccBalances helper (identical to Accounts.jsx logic)
function ccBalances(txns, acctName, settlementDate, today = new Date()) {
  const sd = settlementDate;
  const cy = today.getFullYear(), cm = today.getMonth(), cd = today.getDate();
  let currStart;
  if (cd >= sd) currStart = new Date(cy, cm, sd);
  else currStart = new Date(cy, cm - 1, sd);
  currStart.setHours(0, 0, 0, 0);

  let grossPayable = 0;
  let grossOutstanding = 0;
  let totalPayments = 0;

  for (const t of txns) {
    const dStr = t.Date || '';
    const parts = dStr.split(/[-/]/);
    let d = new Date();
    if (parts.length === 3) {
      if (parts[0].length === 4) d = new Date(parts[0], parts[1] - 1, parts[2]);
      else d = new Date(parts[2], parts[1] - 1, parts[0]);
    }
    const amt = parseFloat(t.INR || t.inr || t.Amount || t.amount || 0);
    const type = String(t['Income/Expense'] || t.type || '').trim();
    const acct = String(t.Account || t.FromAccount || '').trim();
    const dest = String(t.ToAccount || '').trim();

    const isCharge = (type === 'Expense' && acct === acctName) || (type === 'Transfer-Out' && acct === acctName);
    const isPayment = (type === 'Income' && acct === acctName) || (type === 'Transfer-Out' && dest === acctName);

    if (isCharge) {
      if (d < currStart) grossPayable += amt;
      else grossOutstanding += amt;
    }
    if (isPayment) totalPayments += amt;
  }

  const netPayable = Math.max(0, grossPayable - totalPayments);
  const overpayment = Math.max(0, totalPayments - grossPayable);
  const netOutstanding = grossOutstanding - overpayment;

  return { balancePayable: netPayable, outstanding: netOutstanding };
}

// 1. Credit Cards Check
const cards = [
  { name: 'ICICI Credit', settlementDate: 18 },
  { name: 'Amazon Pay ICICI', settlementDate: 18 },
  { name: 'Axis FK', settlementDate: 15 },
  { name: 'HDFC Rupay', settlementDate: 20 }
];

let totalPayable = 0;
let totalOutstanding = 0;

cards.forEach(c => {
  const b = ccBalances(txns, c.name, c.settlementDate, new Date());
  console.log(`Card: ${c.name.padEnd(20)} | Payable: ₹${b.balancePayable.toFixed(2)} | Outstanding: ₹${b.outstanding.toFixed(2)}`);
  totalPayable += b.balancePayable;
  totalOutstanding += b.outstanding;
});

console.log(`Total Credit Card Payable    : ₹${totalPayable.toFixed(2)}`);
console.log(`Total Credit Card Outstanding: ₹${totalOutstanding.toFixed(2)}`);
console.log(`Sum of Payable + Outstanding : ₹${(totalPayable + totalOutstanding).toFixed(2)}`);

// 2. Share Market Breakdown
const bState = calculateBrokerageState(txns, []);
const fg = bState['Fareeda Groww'];
const z = bState['Zerodha'];

console.log('\n--- SHARE MARKET RECONCILIATION TABLE ---');
console.log(`A. Parent Share Market Ledger Balance (raw buildBalanceMap): ₹26,445.55`);
console.log(`B. Fareeda Groww Ledger Cash               : ₹${fg.cashBalance.toFixed(2)}`);
console.log(`C. Zerodha Ledger Cash                     : ₹${z.cashBalance.toFixed(2)}`);
console.log(`D. Fareeda Groww Invested Cost (ETFs)      : ₹${fg.investedCost.toFixed(2)}`);
console.log(`E. Zerodha Invested Cost (Stocks)          : ₹${z.investedCost.toFixed(2)}`);
console.log(`F. Zerodha Current Market Value (Stocks)   : ₹${z.currentMarketValue.toFixed(2)}`);
console.log(`G. Fareeda Groww Total Portfolio Value     : ₹${fg.totalPortfolioValue.toFixed(2)}`);
console.log(`H. Zerodha Total Portfolio Value           : ₹${z.totalPortfolioValue.toFixed(2)}`);
console.log(`I. Accounts.jsx Parent Share Market Display: ₹${(fg.totalPortfolioValue + z.totalPortfolioValue).toFixed(2)} (rounded: ₹${Math.round(fg.totalPortfolioValue + z.totalPortfolioValue).toLocaleString('en-IN')})`);
console.log(`J. Earlier Displayed Parent Share Market   : ₹244,234.00`);
console.log(`K. Difference (Earlier - Current)          : ₹${(244234 - Math.round(fg.totalPortfolioValue + z.totalPortfolioValue)).toLocaleString('en-IN')}`);

