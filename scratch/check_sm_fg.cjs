const fs = require('fs');
const path = require('path');

const csvPath = path.join(__dirname, '..', 'finman_2026-09-03.csv');
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

const smFgTxns = rows.filter(r => {
  const isSM = r.Account === 'Share Market' || r.FromAccount === 'Share Market' || r.ToAccount === 'Share Market' || r.Category === 'Share Market';
  const isFG = r.SubAccount === 'Fareeda Groww' || r.FromSubAccount === 'Fareeda Groww' || r.ToSubAccount === 'Fareeda Groww' || r.Brokerage === 'Fareeda Groww' || JSON.stringify(r).includes('Fareeda Groww');
  return isSM && isFG;
});

console.log(`Found ${smFgTxns.length} Share Market Fareeda Groww transactions:`);
smFgTxns.forEach(r => {
  console.log(`${r.Date} | Type: ${r['Income/Expense']} | InvType: ${r.InvestmentTransactionType} | From: ${r.FromAccount} (${r.FromSubAccount}) | To: ${r.ToAccount} (${r.ToSubAccount}) | Sub: ${r.SubAccount} | Broker: ${r.Brokerage} | Amt: ${r.INR || r.Amount} | Symbol: ${r.SecuritySymbol || r.Note}`);
});
