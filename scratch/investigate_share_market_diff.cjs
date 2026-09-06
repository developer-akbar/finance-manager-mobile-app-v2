const fs = require('fs');
const path = require('path');
const { parseCSV } = require('../src/utils/csvParser.js');
const { calculateBrokerageState } = require('../src/utils/brokerageAccounting.js');

const rawCsv = fs.readFileSync(path.join(__dirname, '..', 'finman_2026-09-05.csv'), 'utf8');
const txns = parseCSV(rawCsv);
const brokerState = calculateBrokerageState(txns, []);

const fg = brokerState['Fareeda Groww'];
const z = brokerState['Zerodha'];

console.log('Fareeda Groww:', fg);
console.log('Zerodha:', z);

console.log('\n--- CANDIDATE COMBINATIONS FOR ₹244,234 vs ₹204,489 (Diff = ₹39,745) ---');
console.log(`1. Current UI sum (FG Total + Zerodha Total): ${fg.totalPortfolioValue} + ${z.totalPortfolioValue} = ${fg.totalPortfolioValue + z.totalPortfolioValue}`);
console.log(`2. FG Total + Zerodha Total + Zerodha Invested Cost: ${fg.totalPortfolioValue + z.totalPortfolioValue} + ${z.investedCost} = ${fg.totalPortfolioValue + z.totalPortfolioValue + z.investedCost}`);
console.log(`3. FG Cash + FG Inv + Zerodha Cash + Zerodha MarketVal + Zerodha InvestedCost: ${fg.cashBalance + fg.investedCost + z.cashBalance + z.currentMarketValue + z.investedCost}`);
console.log(`4. Raw Ledger Share Market balance: ${26445.55}`);

// Let's check if earlier dataset had different Zerodha or Fareeda Groww balances
// What if Zerodha total + FG cash + FG invested + Zerodha invested = 57203.11 + 147403.43 + 39704.98 = 244311.52
console.log(`5. 204606.54 + 39704.98 (Zerodha Invested Cost) = ${204606.54 + 39704.98}`);
