const fs = require('fs');
const path = require('path');

const csvPath = path.join(__dirname, '..', 'finman_2026-09-05.csv');
const content = fs.readFileSync(csvPath, 'utf8');
const lines = content.split('\n').filter(l => l.trim());
const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));

const transactions = lines.slice(1).map(line => {
  const values = [];
  let inQuotes = false;
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ',' && !inQuotes) { values.push(cur.trim().replace(/^"|"$/g, '')); cur = ''; }
    else cur += c;
  }
  values.push(cur.trim().replace(/^"|"$/g, ''));
  const obj = {};
  headers.forEach((h, idx) => { obj[h] = values[idx] || ''; });
  return obj;
});

const { calculateBrokerageState } = require('../src/utils/brokerageAccounting.js');

let canaraBal = 0;
transactions.forEach(t => {
  const amt = parseFloat(t.INR || t.Amount || 0);
  const type = t['Income/Expense'] || '';
  const acct = t.Account || t.FromAccount || '';
  const dest = t.ToAccount || '';

  if (type === 'Income' && (acct === 'Canara' || dest === 'Canara')) {
    canaraBal += amt;
  } else if (type === 'Expense' && acct === 'Canara') {
    canaraBal -= amt;
  } else if (type.startsWith('Transfer')) {
    if (acct === 'Canara' && dest !== 'Canara') canaraBal -= amt;
    if (dest === 'Canara' && acct !== 'Canara') canaraBal += amt;
  }
});

const state = calculateBrokerageState(transactions, [{ name: 'Fareeda Groww' }]);
const fg = state['Fareeda Groww'];

console.log('Canara Cash Balance:', canaraBal);
console.log('Fareeda Groww Cash Balance:', fg.cashBalance);
console.log('Fareeda Groww Invested Cost:', fg.investedCost);
console.log('Fareeda Groww Total Value:', fg.totalPortfolioValue);
