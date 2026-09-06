const fs = require('fs');

function parseCSV(text) {
  const lines = text.split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/^\"|\"$/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const row = [];
    let inQ = false, cur = '';
    for (let j = 0; j < lines[i].length; j++) {
      const c = lines[i][j];
      if (c === '"') inQ = !inQ;
      else if (c === ',' && !inQ) { row.push(cur); cur = ''; }
      else cur += c;
    }
    row.push(cur);
    const obj = {};
    headers.forEach((h, idx) => obj[h] = row[idx] ? row[idx].trim().replace(/^\"|\"$/g, '') : '');
    rows.push(obj);
  }
  return rows;
}

const txns = parseCSV(fs.readFileSync('finman_2026-09-02.csv', 'utf8'));

let bal = 0;
for (const t of txns) {
  const amt = parseFloat(t.Amount || t.INR || 0) || 0;
  const type = String(t['Income/Expense'] || '').trim();
  const acct = String(t.Account || '').trim();
  const fromAcct = String(t.FromAccount || t.Account || '').trim();
  const dest = String(t.ToAccount || '').trim();
  if (type === 'Income' && (dest === 'Mutual Funds Tax Saver' || acct === 'Mutual Funds Tax Saver')) bal += amt;
  else if (type === 'Expense' && (fromAcct === 'Mutual Funds Tax Saver' || acct === 'Mutual Funds Tax Saver')) bal -= amt;
  else if (type === 'Transfer-Out') {
    if (fromAcct === 'Mutual Funds Tax Saver') bal -= amt;
    if (dest === 'Mutual Funds Tax Saver') bal += amt;
  }
}
console.log('Parent balance of Mutual Funds Tax Saver:', bal);
