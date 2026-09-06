const fs = require('fs');
const { parseCSV } = require('../src/utils/csvParser.js');
const { getUnifiedPortfolioData } = require('../src/utils/portfolioSelector.js');

const csvContent = fs.readFileSync('finman_2026-09-05.csv', 'utf8');
const transactions = parseCSV(csvContent);

const portfolio = getUnifiedPortfolioData(transactions);
const { allPositions, mfPositions, shareMarketPositions } = portfolio;

console.log('--- EXHAUSTIVE UNITS SEARCH ---');

// 1. All positions currentUnits
const allCurrentUnits = allPositions.reduce((sum, p) => sum + (p.currentUnits || 0), 0);
console.log(`1. All positions (Personal + Father) active currentUnits: ${allCurrentUnits.toFixed(3)}`);

// 2. All positions buyUnits
const allBuyUnits = allPositions.reduce((sum, p) => sum + (p.buyUnits || 0), 0);
console.log(`2. All positions (Personal + Father + Redeemed) buyUnits: ${allBuyUnits.toFixed(3)}`);

// 3. Raw CSV transactions total BUY quantity
let rawBuyQty = 0;
let rawMFBuyQty = 0;
let rawSMBuyQty = 0;
let rawTxnQtySum = 0;

transactions.forEach(t => {
  const qty = parseFloat(t.Quantity) || 0;
  rawTxnQtySum += qty;
  const type = (t.InvestmentTransactionType || t['Income/Expense'] || '').toUpperCase();
  if (type === 'BUY' || type === 'PURCHASE') {
    rawBuyQty += qty;
    if (t.Account === 'Share Market') rawSMBuyQty += qty;
    else rawMFBuyQty += qty;
  }
});

console.log(`3. Raw CSV all transactions Quantity sum: ${rawTxnQtySum.toFixed(3)}`);
console.log(`4. Raw CSV BUY transactions Quantity sum: ${rawBuyQty.toFixed(3)} (MF: ${rawMFBuyQty.toFixed(3)}, SM: ${rawSMBuyQty.toFixed(3)})`);

// 5. Let's check liquid MF or Nippon Liquid / Liquid fund units in transactions
const liquidTxns = transactions.filter(t => (t.Note || t.Description || '').toLowerCase().includes('liquid') || (t.Note || t.Description || '').toLowerCase().includes('ultra short'));
const liquidQtySum = liquidTxns.reduce((sum, t) => sum + (parseFloat(t.Quantity) || 0), 0);
console.log(`5. Liquid fund transaction quantities sum: ${liquidQtySum.toFixed(3)}`);

// 6. Check if 65510.591 appears anywhere in raw CSV text or subaccount sums
console.log(`6. Direct string check for 65510 in CSV: ${csvContent.includes('65510')}`);
