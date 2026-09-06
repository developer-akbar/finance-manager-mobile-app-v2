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
    obj._line = i + 1;
    rows.push(obj);
  }
  return rows;
}

const txns = parseCSV(fs.readFileSync('finman_2026-09-02.csv', 'utf8'));

console.log('=== All transactions on 14/11/2024 mentioning Tax Saver ===');
for (const t of txns) {
  if (t.Date === '14/11/2024') {
    const s = JSON.stringify(t);
    if (s.includes('Tax Saver') || s.includes('ELSS') || s.includes('204000') || s.includes('116000')) {
      console.log(`Line ${t._line} | Type: ${t['Income/Expense']} | InvType: ${t.InvestmentTransactionType} | ${t.FromAccount || t.Account} -> ${t.ToAccount} | Amt: ${t.Amount} | Note: ${t.Note}`);
    }
  }
}
