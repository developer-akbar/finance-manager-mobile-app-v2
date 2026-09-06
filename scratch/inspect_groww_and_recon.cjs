const fs = require('fs');

function parseCSV(content) {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0) return [];
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseCSVLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = values[idx] !== undefined ? values[idx] : '';
    });
    rows.push(obj);
  }
  return rows;
}

function parseCSVLine(text) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      result.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

const raw = fs.readFileSync('finman_2026-08-30_shares_data.csv', 'utf8');
const rows = parseCSV(raw);

// 1. Check if any RECONCILIATION row exists in CSV
console.log('=== CHECKING RECONCILIATION ROWS IN CSV ===');
const reconRows = rows.filter(r => {
  const s = JSON.stringify(r).toLowerCase();
  return s.includes('reconciliation');
});
console.log(`Found ${reconRows.length} reconciliation rows in CSV:`);
reconRows.forEach((r, i) => {
  console.log(`  ${i+1}. Date: ${r.Date} | Type: ${r['Income/Expense']} | Acct: ${r.Account || r.FromAccount} -> ${r.ToAccount} | Sub: ${r.SubAccount || r.FromSubAccount} | INR: ${r.INR} | Note: ${r.Note} | Desc: ${r.Description}`);
});

// 2. Check Fareeda Groww / Groww rows in CSV
console.log('\n=== CHECKING FAREEDA GROWW / GROWW ROWS IN CSV ===');
const growwRows = rows.filter(r => {
  const s = JSON.stringify(r).toLowerCase();
  return s.includes('groww') || s.includes('fareeda');
});
console.log(`Total rows mentioning groww or fareeda: ${growwRows.length}`);

// Group groww rows by Account / SubAccount
const growwByAcct = {};
growwRows.forEach(r => {
  const acct = r.Account || r.FromAccount || 'UNKNOWN';
  const dest = r.ToAccount || '';
  const sub = r.SubAccount || r.FromSubAccount || r.ToSubAccount || 'NONE';
  const key = `${acct} -> ${dest} | Sub: ${sub} | Type: ${r['Income/Expense']}`;
  const inr = parseFloat(r.INR || r.Amount || 0);
  if (!growwByAcct[key]) growwByAcct[key] = { count: 0, total: 0 };
  growwByAcct[key].count++;
  growwByAcct[key].total += inr;
});
console.log('Groww/Fareeda row breakdown:', JSON.stringify(growwByAcct, null, 2));

// Check specifically Share Market -> Fareeda Groww
const fareedaSM = rows.filter(r => {
  const acct = r.Account || r.FromAccount || '';
  const dest = r.ToAccount || '';
  const sub = r.SubAccount || r.FromSubAccount || r.ToSubAccount || '';
  const s = JSON.stringify(r).toLowerCase();
  return (acct === 'Share Market' || dest === 'Share Market' || s.includes('share market')) && (s.includes('fareeda') || s.includes('groww'));
});
console.log(`\nShare Market Fareeda/Groww rows count: ${fareedaSM.length}`);
fareedaSM.forEach((r, i) => {
  console.log(`  ${i+1}. Date: ${r.Date} | Type: ${r['Income/Expense']} | Acct: ${r.Account || r.FromAccount} -> ${r.ToAccount} | Sub: ${r.SubAccount} | FromSub: ${r.FromSubAccount} | ToSub: ${r.ToSubAccount} | INR: ${r.INR} | Note: ${r.Note} | Desc: ${r.Description}`);
});

// Check all Liquid Mutual Funds / Mutual Funds for Fareeda Groww
const fareedaMF = rows.filter(r => {
  const s = JSON.stringify(r).toLowerCase();
  return s.includes('fareeda') && (s.includes('groww') || s.includes('etmoney') || s.includes('mutual'));
});
console.log(`\nFareeda Mutual Fund rows count: ${fareedaMF.length}`);
fareedaMF.forEach((r, i) => {
  console.log(`  ${i+1}. Date: ${r.Date} | Type: ${r['Income/Expense']} | Acct: ${r.Account || r.FromAccount} -> ${r.ToAccount} | Sub: ${r.SubAccount} | FromSub: ${r.FromSubAccount} | ToSub: ${r.ToSubAccount} | INR: ${r.INR} | Note: ${r.Note} | Desc: ${r.Description}`);
});

