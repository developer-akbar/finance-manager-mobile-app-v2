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

// Check buildBalanceMap from Accounts.jsx
function buildBalanceMap(transactions) {
  const map = {};
  const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(String(s).trim());
  const ensure = n => { if (n && !looksNumeric(n) && !map[n]) map[n] = 0; };
  const addTo = (n, v) => { if (n && !looksNumeric(n)) { ensure(n); map[n] = (map[n] || 0) + v; } };

  for (const t of transactions) {
    const amt = parseFloat(t.INR || t.Amount || 0) || 0;
    const type = String(t['Income/Expense'] || '').trim();
    const acct = String(t.Account || '').trim();
    const fromAcct = String(t.FromAccount || t.Account || '').trim();
    const dest = String(t.ToAccount || '').trim();

    if (type === 'Income') {
      addTo(dest || acct, +amt);
    } else if (type === 'Expense') {
      addTo(fromAcct || acct, -amt);
    } else if (type === 'Transfer-Out') {
      addTo(fromAcct, -amt);
      addTo(dest, +amt);
    }
  }
  return map;
}

const bMap = buildBalanceMap(txns);
console.log('Parent Mutual Funds Tax Saver in buildBalanceMap:', bMap['Mutual Funds Tax Saver']);

// Wait! How did parent become 204,000 in the UI?
// Let's check where 204,000 comes from:
// Total Tax Saver acquisitions: 320,000?
// Wait, 320,000 - 116,000 = 204,000!
// 116,000 is the cost basis of the redeemed ELSS funds!
// 320,000 - 116,000 = 204,000!
console.log('320,000 - 116,000 =', 320000 - 116000);
