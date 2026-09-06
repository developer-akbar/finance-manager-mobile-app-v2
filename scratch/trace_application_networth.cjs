const fs = require('fs');

function parseCSV(text) {
  if (!text || !text.trim()) return { headers: [], rows: [] };
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const records = [];
  let fields = [];
  let field = '';
  let inQ = false;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (inQ) {
      if (ch === '"' && next === '"') {
        field += '"'; i += 2; continue;
      }
      if (ch === '"') {
        inQ = false; i++; continue;
      }
      field += ch; i++; continue;
    }

    if (ch === '"') {
      inQ = true; i++; continue;
    }
    if (ch === ',') {
      fields.push(field); field = ''; i++; continue;
    }
    if (ch === '\n') {
      fields.push(field); field = '';
      records.push(fields); fields = [];
      i++; continue;
    }
    field += ch; i++;
  }
  fields.push(field);
  if (fields.some(f => f !== '')) records.push(fields);

  if (records.length < 2) return { headers: [], rows: [] };
  const headers = records[0].map(h => h.trim());
  const rows = [];

  for (let ri = 1; ri < records.length; ri++) {
    const rec = records[ri];
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = (rec[idx] || '').trim();
    });
    if (Object.values(row).every(v => !v)) continue;
    rows.push(row);
  }
  return { headers, rows };
}

const v4_2 = parseCSV(fs.readFileSync('scratch/finman_reconstructed_master_preview_v4_2.csv', 'utf8'));

// Replicate Dashboard.jsx / Accounts.jsx balance logic
const acctBalances = {};
const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(String(s).trim());
const ensure = n => { if (n && !looksNumeric(n) && !acctBalances[n]) acctBalances[n] = 0; };
const addTo = (n, v) => { if (n && !looksNumeric(n)) { ensure(n); acctBalances[n] = (acctBalances[n] || 0) + v; } };

for (const t of v4_2.rows) {
  const amt = parseFloat(t.INR || t.Amount || 0);
  if (isNaN(amt) || amt === 0) continue;
  const type = String(t['Income/Expense'] || '').trim();
  const acct = String(t.Account || t.FromAccount || '').trim();
  const dest = String(t.ToAccount || '').trim();

  if (type === 'Income') addTo(acct, +amt);
  else if (type === 'Expense') addTo(acct, -amt);
  else if (type === 'Transfer-Out' || type === 'Transfer') { addTo(acct, -amt); addTo(dest, +amt); }
}

console.log('=== ACCOUNT BALANCES IN V4.2 ===');
let totalSum = 0;
let positiveSum = 0;
let negativeSum = 0;

for (const [k, v] of Object.entries(acctBalances).sort()) {
  totalSum += v;
  if (v > 0) positiveSum += v;
  else negativeSum += v;
  console.log(`${k.padEnd(25)} : ₹${v.toFixed(2).padStart(12)}`);
}

console.log('--------------------------------------------------');
console.log(`Total Net Worth (Sum of all accounts): ₹${totalSum.toFixed(2)}`);
console.log(`Total Positive Balances:              ₹${positiveSum.toFixed(2)}`);
console.log(`Total Negative Balances:              ₹${negativeSum.toFixed(2)}`);
console.log(`Positive + Negative:                  ₹${(positiveSum + negativeSum).toFixed(2)}`);

