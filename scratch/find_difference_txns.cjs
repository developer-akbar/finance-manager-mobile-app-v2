const fs = require('fs');
const path = require('path');

const csvPath = path.join(__dirname, '..', 'finman_2026-09-05.csv');
const content = fs.readFileSync(csvPath, 'utf8');
const lines = content.split('\n').filter(l => l.trim());
const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));

const rows = lines.slice(1).map(line => {
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

const { parseTxnFields } = require('../src/utils/brokerageAccounting.js');

const fgTxns = rows.filter(t => {
  const isSM = t.Account === 'Share Market' || t.FromAccount === 'Share Market' || t.ToAccount === 'Share Market' || t.Category === 'Share Market';
  const isFG = t.SubAccount === 'Fareeda Groww' || t.FromSubAccount === 'Fareeda Groww' || t.ToSubAccount === 'Fareeda Groww' || t.Brokerage === 'Fareeda Groww' || JSON.stringify(t).includes('Fareeda Groww');
  return isSM && isFG;
});

console.log('=== DETAILED RECONCILIATION OF ALL 21 DATASET TRANSACTIONS ===\n');

let datasetCash = 0;
fgTxns.forEach((t, i) => {
  const amt = parseFloat(t.INR || t.Amount || t.TradeValue || 0);
  const type = t['Income/Expense'] || '';
  const invType = t.InvestmentTransactionType || '';
  const acct = t.Account || t.FromAccount || '';
  const dest = t.ToAccount || '';
  const ci = t.CashImpact !== '' ? parseFloat(t.CashImpact) : null;

  let delta = 0;
  let descStr = '';

  if (invType === 'BUY') {
    delta = -amt;
    descStr = `BUY ${t.SecuritySymbol || t.Note} (${t.Quantity} @ ₹${t.UnitPrice})`;
  } else if (invType === 'SELL') {
    delta = ci !== null ? ci : amt;
    descStr = `SELL ${t.SecuritySymbol || t.Note} (${t.Quantity} @ ₹${t.UnitPrice})`;
  } else if (type.startsWith('Transfer')) {
    if (acct !== 'Share Market' && dest === 'Share Market') {
      delta = amt;
      descStr = `Deposit from ${acct} (${t.Note || 'Transfer'})`;
    } else if (acct === 'Share Market' && dest !== 'Share Market') {
      delta = -amt;
      descStr = `Withdrawal to ${dest} (${t.Note || 'Transfer'})`;
    }
  }

  datasetCash += delta;
  console.log(`[${i+1}] ${t.Date} | ${descStr} | ID: ${t.ID || t._id} | Delta: ${delta > 0 ? '+' : ''}${delta.toFixed(2)} | Running Cash: ₹${datasetCash.toFixed(2)}`);
});
