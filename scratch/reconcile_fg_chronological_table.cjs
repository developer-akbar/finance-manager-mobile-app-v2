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

const fgTxns = rows.filter(t => {
  const isSM = t.Account === 'Share Market' || t.FromAccount === 'Share Market' || t.ToAccount === 'Share Market' || t.Category === 'Share Market';
  const isFG = t.SubAccount === 'Fareeda Groww' || t.FromSubAccount === 'Fareeda Groww' || t.ToSubAccount === 'Fareeda Groww' || t.Brokerage === 'Fareeda Groww' || JSON.stringify(t).includes('Fareeda Groww');
  return isSM && isFG;
});

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

// Map of exact paise net proceeds / cash impacts
const exactPaiseMap = {
  '9623c148-9c23-48a6-99bb-3e2b454e67c1': 2511.70,   // Indiabulls SELL
  '56b665f6-e40a-4cb3-950d-97071a91d861': 19998.03,  // Lalithaa SELL
  'c2a762ff-ccf5-48e6-b59b-3c42250fcb65': 20336.34,  // Lumino SELL
  'cc0ab0c1-cc10-4f04-8889-6078f6faed3a': 29244.36   // ESDS SELL
};

console.log('=== CHRONOLOGICAL RECONCILIATION TABLE (EXACT TRANSACTIONS) ===\n');

let runningCashPaise = 0;
let runningCashCsv = 0;

let fundingThrough29Jul = 0;
let fundingAfter29Jul = 0;
let buyOutflows = 0;
let sellInflowsPaise = 0;
let sellInflowsCsv = 0;

const tableRows = [];

fgTxns.forEach((t, idx) => {
  const id = t.ID || t._id;
  const d = t.Date;
  const dObj = parseDate(d);
  const type = t['Income/Expense'] || 'Transfer-Out';
  const invType = t.InvestmentTransactionType || '';
  const fromAcct = t.FromAccount || t.Account || '';
  const fromSub = t.FromSubAccount || t.SubAccount || '';
  const toAcct = t.ToAccount || '';
  const toSub = t.ToSubAccount || t.SubAccount || '';
  const symbol = normalizeSymbol(t.SecuritySymbol || t.Note || '');
  const amt = parseFloat(t.INR || t.Amount || t.TradeValue || 0);

  let cashEffectPaise = 0;
  let cashEffectCsv = 0;
  let buySellTag = '';

  if (invType === 'BUY') {
    buySellTag = `BUY ${symbol}`;
    cashEffectPaise = -amt;
    cashEffectCsv = -amt;
    buyOutflows += amt;
  } else if (invType === 'SELL') {
    buySellTag = `SELL ${symbol}`;
    const exactPaise = exactPaiseMap[id] !== undefined ? exactPaiseMap[id] : amt;
    cashEffectPaise = exactPaise;
    cashEffectCsv = amt;
    sellInflowsPaise += exactPaise;
    sellInflowsCsv += amt;
  } else if (type.startsWith('Transfer')) {
    if (fromAcct !== 'Share Market' && toAcct === 'Share Market') {
      cashEffectPaise = amt;
      cashEffectCsv = amt;
      if (dObj <= new Date(2026, 6, 29)) { // 29-Jul-2026
        fundingThrough29Jul += amt;
      } else {
        fundingAfter29Jul += amt;
      }
      buySellTag = `Deposit (${t.Note || 'Funding'})`;
    }
  }

  runningCashPaise += cashEffectPaise;
  runningCashCsv += cashEffectCsv;

  tableRows.push({
    num: idx + 1,
    date: d,
    id,
    type,
    fromStr: `${fromAcct}${fromSub ? ' (' + fromSub + ')' : ''}`,
    toStr: `${toAcct}${toSub ? ' (' + toSub + ')' : ''}`,
    buySellTag,
    cashEffectPaise,
    runningCashPaise,
    cashEffectCsv,
    runningCashCsv
  });
});

// Print Table
console.log('No | Date       | ID                                   | Type         | From Account         | To Account           | Tag / Security            | Cash Effect (Paise) | Running Cash (Paise) | Running Cash (CSV)');
console.log('---|------------|--------------------------------------|--------------|----------------------|----------------------|---------------------------|---------------------|----------------------|-------------------');
tableRows.forEach(r => {
  console.log(`${String(r.num).padStart(2)} | ${r.date.padEnd(10)} | ${r.id.padEnd(36)} | ${r.type.padEnd(12)} | ${r.fromStr.padEnd(20)} | ${r.toStr.padEnd(20)} | ${r.buySellTag.padEnd(25)} | ${String(r.cashEffectPaise >= 0 ? '+' + r.cashEffectPaise.toFixed(2) : r.cashEffectPaise.toFixed(2)).padStart(19)} | ₹${r.runningCashPaise.toFixed(2).padStart(20)} | ₹${r.runningCashCsv.toFixed(2).padStart(17)}`);
});

// Add DDPI Data Correction Row
const ddpiExp = 118.00;
const cashWithDdpiPaise = runningCashPaise - ddpiExp;
const cashWithDdpiCsv = runningCashCsv - ddpiExp;

console.log(`22 | [DATA FIX] | [MISSING IN CSV]                    | Expense      | Share Market (FG)    | DDPI Charge          | DDPI Charges              |             -118.00 | ₹${cashWithDdpiPaise.toFixed(2).padStart(20)} | ₹${cashWithDdpiCsv.toFixed(2).padStart(17)}`);

console.log('\n========================================================================');
console.log('SUMMARY METRICS REPORT');
console.log('========================================================================');
console.log(`A. Total existing Canara → Share Market funding through 29-Jul:  ₹${fundingThrough29Jul.toFixed(2)}`);
console.log(`B. Total subsequent Canara → Share Market funding after 29-Jul:   ₹${fundingAfter29Jul.toFixed(2)}`);
console.log(`   [Total Canara → Share Market Funding All Time]:               ₹${(fundingThrough29Jul + fundingAfter29Jul).toFixed(2)}`);
console.log(`C. Total BUY cash outflows:                                     ₹${buyOutflows.toFixed(2)}`);
console.log(`D. Total SELL net cash inflows (Exact Paise):                   ₹${sellInflowsPaise.toFixed(2)}`);
console.log(`   Total SELL net cash inflows (CSV Integer):                   ₹${sellInflowsCsv.toFixed(2)}`);
console.log(`E. DDPI expense (Required Data Correction):                     ₹${ddpiExp.toFixed(2)}`);
console.log(`F. Current Share Market cash balance (CSV Exact):               ₹${runningCashCsv.toFixed(2)}`);
console.log(`   Current Share Market cash balance (Exact Paise with DDPI):   ₹${cashWithDdpiPaise.toFixed(2)}`);

const goldBeesCost = 3281.00;
const silverBeesCost = 1681.00;
const activeInvestedCost = goldBeesCost + silverBeesCost; // 4,962.00 (active ETF cost in cash outflows)

console.log(`G. Active investment cost (Gold BeES + SilverBeES):             ₹${activeInvestedCost.toFixed(2)} (Actual Cost Basis = ₹4,950.00)`);
console.log(`H. Total brokerage account value at cost (Cash + Active Cost):  ₹${(runningCashCsv + 4950.00).toFixed(2)}`);
console.log('========================================================================\n');
