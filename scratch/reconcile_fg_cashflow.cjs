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

const { parseTxnFields, normalizeSymbol } = require('../src/utils/brokerageAccounting.js');

// Filter all Share Market / Fareeda Groww transactions
const fgTxns = rows.filter(t => {
  const isSM = t.Account === 'Share Market' || t.FromAccount === 'Share Market' || t.ToAccount === 'Share Market' || t.Category === 'Share Market';
  const isFG = t.SubAccount === 'Fareeda Groww' || t.FromSubAccount === 'Fareeda Groww' || t.ToSubAccount === 'Fareeda Groww' || t.Brokerage === 'Fareeda Groww' || JSON.stringify(t).includes('Fareeda Groww');
  return isSM && isFG;
});

console.log(`Total Fareeda Groww Share Market transactions found: ${fgTxns.length}`);

// Sort chronologically (DD/MM/YYYY)
function parseDate(dStr) {
  if (!dStr) return new Date(0);
  const parts = dStr.split(/[\/-]/);
  if (parts.length === 3) {
    let day = parseInt(parts[0], 10);
    let month = parseInt(parts[1], 10) - 1;
    let year = parseInt(parts[2], 10);
    if (year < 100) year += 2000;
    return new Date(year, month, day);
  }
  return new Date(dStr);
}

fgTxns.sort((a, b) => {
  const da = parseDate(a.Date);
  const db = parseDate(b.Date);
  if (da - db !== 0) return da - db;
  return (a.Time || '').localeCompare(b.Time || '');
});

console.log('\n========================================================================');
console.log('CHRONOLOGICAL LIST OF FAREEDA GROWW SHARE MARKET TRANSACTIONS');
console.log('========================================================================');
fgTxns.forEach((t, idx) => {
  const f = parseTxnFields(t);
  const amt = parseFloat(t.INR || t.Amount || t.TradeValue || 0);
  const ci = t.CashImpact !== '' ? parseFloat(t.CashImpact) : null;
  console.log(`[${idx+1}] ID: ${t.ID || t._id} | Date: ${t.Date} | Type: ${t['Income/Expense']} | InvType: ${t.InvestmentTransactionType} | From: ${t.FromAccount} (${t.FromSubAccount}) | To: ${t.ToAccount} (${t.ToSubAccount}) | Amt: ${amt} | CashImpact: ${ci} | CostBasis: ${t.CostBasis} | PnL: ${t.RealizedPnl} | Symbol: ${t.SecuritySymbol || t.Note} | Desc: ${t.Description}`);
});
