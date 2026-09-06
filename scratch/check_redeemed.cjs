const fs = require('fs');
const path = require('path');

async function checkRedeemed() {
  const engineModule = await import('../src/utils/mutualFundPositionEngine.js');
  const csvPath = path.resolve('finman_2026-09-02.csv');
  
  function parseCSV(text) {
    const lines = text.split('\n');
    const headers = lines[0].split(',').map(h => h.trim().replace(/^\"|\"$/g, ''));
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      // split by comma ignoring quotes
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

  const txns = parseCSV(fs.readFileSync(csvPath, 'utf8'));
  const res = engineModule.calculateMutualFundPositions(txns);
  const red = res.positions.filter(p => p.status === 'REDEEMED');
  console.log('Redeemed positions count:', red.length);
  red.forEach(p => console.log(p.subAccount, '|', p.isin, '|', p.note || p.security, '| Realized:', p.realizedPnl));
}

checkRedeemed();
