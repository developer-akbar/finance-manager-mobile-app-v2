const fs = require('fs');
const path = require('path');

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

// Search for all dividend rows across ALL accounts
const dividendRows = rows.filter(r => {
  const str = JSON.stringify(r).toLowerCase();
  return str.includes('dividend');
});

console.log('Total dividend rows across whole CSV:', dividendRows.length);
let divTotal = 0;
let divZerodha = 0;
dividendRows.forEach(r => {
  const amt = parseFloat(r.INR || r.Amount || 0);
  divTotal += amt;
  const isZ = JSON.stringify(r).toLowerCase().includes('zerodha');
  if (isZ) divZerodha += amt;
  console.log(`Div row: Date: ${r.Date}, Type: ${r['Income/Expense']}, Acct: ${r.Account || r.FromAccount}, Cat: ${r.Category}, Note: ${r.Note}, INR: ${r.INR}`);
});
console.log('Total Dividends:', divTotal, 'Zerodha specific dividends in CSV:', divZerodha);

// Search for IPO rows
const ipoRows = rows.filter(r => {
  const str = JSON.stringify(r).toLowerCase();
  return str.includes('ipo');
});
console.log('\nTotal IPO rows across whole CSV:', ipoRows.length);
ipoRows.forEach(r => {
  console.log(`IPO row: Date: ${r.Date}, Type: ${r['Income/Expense']}, From: ${r.FromAccount || r.Account}, To: ${r.ToAccount}, Cat: ${r.Category}, Note: ${r.Note}, Desc: ${r.Description}, INR: ${r.INR}`);
});

// Search for all transactions involving 'Share Market'
const smRows = rows.filter(r => {
  return r.Account === 'Share Market' || r.FromAccount === 'Share Market' || r.ToAccount === 'Share Market';
});
console.log('\nTotal Share Market rows:', smRows.length);

