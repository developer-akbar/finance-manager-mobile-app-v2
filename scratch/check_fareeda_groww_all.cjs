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

console.log('=== ALL ROWS WITH SubAccount / ToSubAccount = Fareeda Groww ===');
const fareedaRows = rows.filter(r => {
  const sub = r.SubAccount || r.FromSubAccount || r.ToSubAccount || '';
  return sub === 'Fareeda Groww' || sub === 'Groww';
});

console.log(`Total rows: ${fareedaRows.length}`);
fareedaRows.forEach((r, i) => {
  console.log(`${i+1}. Date: ${r.Date} | Type: ${r['Income/Expense']} | ${r.FromAccount || r.Account} -> ${r.ToAccount} | Sub: ${r.SubAccount} | ToSub: ${r.ToSubAccount} | INR: ${r.INR} | Note: ${r.Note} | Desc: ${r.Description}`);
});

// Let's check how Fareeda Groww total value is calculated across accounts
let smFareedaGroww = 0;
let lmfFareedaGroww = 0;

rows.forEach(r => {
  const type = r['Income/Expense'];
  const from = r.FromAccount || r.Account;
  const to = r.ToAccount;
  const sub = r.SubAccount || r.FromSubAccount;
  const toSub = r.ToSubAccount;
  const inr = parseFloat(r.INR || r.Amount || 0);

  if (to === 'Share Market' && toSub === 'Fareeda Groww') smFareedaGroww += inr;
  if (from === 'Share Market' && sub === 'Fareeda Groww') smFareedaGroww -= inr;

  if (to === 'Liquid Mutual Funds' && toSub === 'Fareeda Groww') lmfFareedaGroww += inr;
  if (from === 'Liquid Mutual Funds' && sub === 'Fareeda Groww') lmfFareedaGroww -= inr;
});

console.log(`\nShare Market > Fareeda Groww standard balance: ₹${smFareedaGroww}`);
console.log(`Liquid Mutual Funds > Fareeda Groww standard balance: ₹${lmfFareedaGroww}`);

