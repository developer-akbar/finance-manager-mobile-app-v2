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

const smTxns = rows.filter(r => {
  return r.Account === 'Share Market' || r.FromAccount === 'Share Market' || r.ToAccount === 'Share Market' || r.Brokerage === 'Fareeda Groww' || r.SubAccount === 'Fareeda Groww';
});

console.log(`Found ${smTxns.length} Share Market transactions:`);
smTxns.forEach(r => {
  console.log(`${r.Date} | InvType: ${r.InvestmentTransactionType} | From: ${r.FromAccount} (${r.FromSubAccount}) | To: ${r.ToAccount} (${r.ToSubAccount}) | Amt: ${r.INR || r.Amount} | Symbol: ${r.SecuritySymbol || r.Note}`);
});
