const fs = require('fs');
const { parseCSV } = require('../src/utils/csvParser.js');
const { calculateMutualFundPositions, parseMutualFundTransaction } = require('../src/utils/mutualFundPositionEngine.js');
const { calculateBrokerageState, parseTxnFields } = require('../src/utils/brokerageAccounting.js');

const csvContent = fs.readFileSync('finman_2026-09-05.csv', 'utf8');
const transactions = parseCSV(csvContent);

console.log('=== DETAILED BREAKDOWN PER TASK ===\n');

// ---------------------------------------------------------
// TASK 3: Liquid MF Breakdown
// ---------------------------------------------------------
console.log('--- TASK 3: LIQUID MF DETAILED RECONCILIATION ---');
const mfResult = calculateMutualFundPositions(transactions);
const liquidPositions = mfResult.positions.filter(p => p.investmentAccount === 'Liquid Mutual Funds' && p.ownershipTag !== 'FATHER_EXTERNAL');

let fifoLiquidPnlSum = 0;
let totalLiquidProceeds = 0;
let totalLiquidCostBasis = 0;

console.log('Redeemed/Closed Liquid MF Positions in FIFO Engine:');
liquidPositions.filter(p => p.status === 'REDEEMED' || p.realizedPnl !== 0).forEach(p => {
  const sellUnits = p.sellUnits || 0;
  const sellCostBasis = p.sellCostBasis || p.buyCost || 0;
  const totalProceeds = p.totalProceeds || 0;
  const pnl = p.realizedPnl || 0;

  fifoLiquidPnlSum += pnl;
  totalLiquidProceeds += totalProceeds;
  totalLiquidCostBasis += sellCostBasis;
  console.log(`- ${p.note || p.security} (${p.subAccount} | Folio ${p.folioNumber}):`);
  console.log(`  Units Sold: ${sellUnits.toFixed(3)}, Cost Basis: ₹${sellCostBasis.toFixed(2)}, Proceeds: ₹${totalProceeds.toFixed(2)}, FIFO Realized P&L: ₹${pnl.toFixed(2)}`);
});

console.log(`\nLiquid MF Summary:`);
console.log(`Total Liquid MF Redeemed Cost Basis = ₹${totalLiquidCostBasis.toFixed(2)}`);
console.log(`Total Liquid MF Redeemed Proceeds = ₹${totalLiquidProceeds.toFixed(2)}`);
console.log(`Total Portfolio FIFO Realized P&L = ₹${fifoLiquidPnlSum.toFixed(2)}`);

// Category Liquid MF entries
let catLiquidGains = 0;
let catLiquidLosses = 0;
transactions.forEach(t => {
  const sub = t.Subcategory || '';
  const amt = parseFloat(t.INR || t.Amount || 0);
  const type = (t['Income/Expense'] || '').trim();
  if (sub === 'Liquid MF Gains' || (sub.includes('Liquid MF') && type === 'Income')) catLiquidGains += amt;
  if (sub === 'Liquid MF Losses' || (sub.includes('Liquid MF') && type === 'Expense')) catLiquidLosses += amt;
});
console.log(`Categories Liquid MF Gains = ₹${catLiquidGains.toFixed(2)}`);
console.log(`Categories Liquid MF Losses = ₹${catLiquidLosses.toFixed(2)}`);
console.log(`Categories Liquid MF Net = ₹${(catLiquidGains - catLiquidLosses).toFixed(2)}`);

// ---------------------------------------------------------
// TASK 4: Tax Saver Breakdown
// ---------------------------------------------------------
console.log('\n--- TASK 4: TAX SAVER DETAILED RECONCILIATION ---');
const taxPositions = mfResult.positions.filter(p => p.investmentAccount === 'Mutual Funds Tax Saver' && p.ownershipTag !== 'FATHER_EXTERNAL');

let fifoTaxPnlSum = 0;
let totalTaxProceeds = 0;
let totalTaxCostBasis = 0;

taxPositions.filter(p => p.status === 'REDEEMED' || p.realizedPnl !== 0).forEach(p => {
  const sellUnits = p.sellUnits || 0;
  const sellCostBasis = p.sellCostBasis || p.buyCost || 0;
  const totalProceeds = p.totalProceeds || 0;
  const pnl = p.realizedPnl || 0;

  fifoTaxPnlSum += pnl;
  totalTaxProceeds += totalProceeds;
  totalTaxCostBasis += sellCostBasis;
  console.log(`- ${p.note || p.security} (${p.subAccount} | Folio ${p.folioNumber}):`);
  console.log(`  Units Sold: ${sellUnits.toFixed(3)}, Cost Basis: ₹${sellCostBasis.toFixed(2)}, Proceeds: ₹${totalProceeds.toFixed(2)}, FIFO Realized P&L: ₹${pnl.toFixed(2)}`);
});

let catTaxGains = 0;
let catTaxLosses = 0;
transactions.forEach(t => {
  const sub = t.Subcategory || '';
  const amt = parseFloat(t.INR || t.Amount || 0);
  const type = (t['Income/Expense'] || '').trim();
  if (sub === 'Tax MF Gains') catTaxGains += amt;
  if (sub === 'Tax MF Losses') catTaxLosses += amt;
});

console.log(`\nTax Saver Summary:`);
console.log(`Portfolio FIFO Realized P&L = ₹${fifoTaxPnlSum.toFixed(2)}`);
console.log(`Categories Tax MF Gains = ₹${catTaxGains.toFixed(2)}`);
console.log(`Categories Tax MF Losses = ₹${catTaxLosses.toFixed(2)}`);
console.log(`Categories Tax MF Net = ₹${(catTaxGains - catTaxLosses).toFixed(2)}`);
console.log(`Exact Difference = ₹${(fifoTaxPnlSum - catTaxGains).toFixed(2)}`);

// ---------------------------------------------------------
// TASK 5: Zerodha Breakdown
// ---------------------------------------------------------
console.log('\n--- TASK 5: ZERODHA DETAILED RECONCILIATION ---');
const brokerageState = calculateBrokerageState(transactions, [], {});
const zerodhaRedeemed = (brokerageState['Zerodha'] || {}).redeemedHoldings || [];
const zerodhaFifoPnl = zerodhaRedeemed.reduce((sum, h) => sum + (parseFloat(h.realizedPnL) || 0), 0);

console.log(`Portfolio FIFO Realized P&L for Zerodha = ₹${zerodhaFifoPnl.toFixed(2)}`);

let catZerodhaGains = 0;
let catZerodhaLosses = 0;
transactions.forEach(t => {
  const sub = t.Subcategory || '';
  const amt = parseFloat(t.INR || t.Amount || 0);
  if (sub === 'Zerodha Gains') catZerodhaGains += amt;
  if (sub === 'Zerodha Losses') catZerodhaLosses += amt;
});

console.log(`Categories Zerodha Gains = ₹${catZerodhaGains.toFixed(2)}`);
console.log(`Categories Zerodha Losses = ₹${catZerodhaLosses.toFixed(2)}`);
console.log(`Categories Zerodha Net = ₹${(catZerodhaGains - catZerodhaLosses).toFixed(2)}`);
console.log(`Exact Difference = ₹${(zerodhaFifoPnl - (catZerodhaGains - catZerodhaLosses)).toFixed(2)}`);

// ---------------------------------------------------------
// TASK 6: Fareeda Groww Closed Trades
// ---------------------------------------------------------
console.log('\n--- TASK 6: FAREEDA GROWW CLOSED STOCK TRADES ---');
const growwRedeemed = (brokerageState['Fareeda Groww'] || {}).redeemedHoldings || [];
let growwFifoPnl = 0;
growwRedeemed.forEach(h => {
  const pnl = parseFloat(h.realizedPnL) || 0;
  growwFifoPnl += pnl;
  console.log(`- ${h.symbol}: CostBasis = ₹${h.soldCostBasis}, Proceeds = ₹${h.totalProceeds}, RealizedPnl = ₹${pnl.toFixed(2)}`);
});
console.log(`Total Fareeda Groww Realized P&L = ₹${growwFifoPnl.toFixed(2)}`);

console.log('\nCategory/Subcategory analysis of Fareeda Groww stock transactions:');
transactions.forEach(t => {
  const note = (t.Note || t.Description || t.SecuritySymbol || '').toUpperCase();
  if (['ESDS', 'LUMINO', 'LALITHAA', 'INDIABULLS'].some(s => note.includes(s))) {
    console.log(`- Note: ${t.Note}, Type: ${t.InvestmentTransactionType || t['Income/Expense']}, Category: "${t.Category || ''}", Subcategory: "${t.Subcategory || ''}"`);
  }
});
