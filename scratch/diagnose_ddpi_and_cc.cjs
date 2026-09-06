const fs = require('fs');
const path = require('path');
const { parseCSV } = require('../src/utils/csvParser.js');
const { calculateBrokerageState, parseTxnFields } = require('../src/utils/brokerageAccounting.js');

const rawCsv = fs.readFileSync(path.join(__dirname, '..', 'finman_2026-09-05.csv'), 'utf8');
const txns = parseCSV(rawCsv);

console.log('=== DIAGNOSING DDPI TRACE & CREDIT CARD CATEGORY SPLIT ===\n');

// 1. Trace DDPI in calculateBrokerageState
const bState = calculateBrokerageState(txns, []);
const fg = bState['Fareeda Groww'];
const z = bState['Zerodha'];

console.log('--- BROKERAGE ACCOUNTING OUTPUT ---');
console.log(`Fareeda Groww cashBalance        : ₹${fg.cashBalance.toFixed(2)}`);
console.log(`Fareeda Groww investedCost (ETFs): ₹${fg.investedCost.toFixed(2)}`);
console.log(`Fareeda Groww totalPortfolioValue: ₹${fg.totalPortfolioValue.toFixed(2)}`);
console.log(`Zerodha totalPortfolioValue      : ₹${z.totalPortfolioValue.toFixed(2)}`);
console.log(`Parent Share Market sum          : ₹${(fg.totalPortfolioValue + z.totalPortfolioValue).toFixed(2)} (rounded: ₹${Math.round(fg.totalPortfolioValue + z.totalPortfolioValue).toLocaleString('en-IN')})`);

// 2. Trace Credit Card Category Split
// Inline ccBalances helper from Accounts.jsx
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

  return { balancePayable: netPayable, outstanding: netOutstanding, grossPayable, grossOutstanding, totalPayments };
}

const cards = [
  { name: 'ICICI Credit', settlementDate: 18 },
  { name: 'Amazon Pay ICICI', settlementDate: 18 },
  { name: 'Axis FK', settlementDate: 15 },
  { name: 'HDFC Rupay', settlementDate: 20 }
];

console.log('\n--- CREDIT CARD INDIVIDUAL CARDS BREAKDOWN ---');
let indPayable = 0;
let indOutstanding = 0;

cards.forEach(c => {
  const res = ccBalances(txns, c.name, c.settlementDate, new Date());
  console.log(`${c.name.padEnd(20)}: GrossPayable=₹${res.grossPayable}, GrossOutstanding=₹${res.grossOutstanding}, Payments=₹${res.totalPayments} => NetPayable=₹${res.balancePayable}, NetOutstanding=₹${res.outstanding}`);
  indPayable += res.balancePayable;
  indOutstanding += res.outstanding;
});

console.log(`\nIndividual Cards Sum: NetPayable=₹${indPayable}, NetOutstanding=₹${indOutstanding}, Total=₹${indPayable + indOutstanding}`);

