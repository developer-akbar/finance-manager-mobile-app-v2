const fs = require('fs');
const path = require('path');

async function check() {
  const engineModule = await import('../src/utils/mutualFundPositionEngine.js');
  const csvPath = path.resolve('finman_2026-09-02.csv');
  
  // Use the same parseCSV function
  function parseCSV(text) {
    const rows = [];
    let row = [];
    let inQuotes = false;
    let cur = '';

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const nextCh = text[i + 1];

      if (ch === '"') {
        if (inQuotes && nextCh === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        row.push(cur);
        cur = '';
      } else if ((ch === '\r' || ch === '\n') && !inQuotes) {
        if (ch === '\r' && nextCh === '\n') i++;
        row.push(cur);
        if (row.length > 1 || (row.length === 1 && row[0] !== '')) {
          rows.push(row);
        }
        row = [];
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur !== '' || row.length > 0) {
      row.push(cur);
      rows.push(row);
    }

    const headers = rows[0].map(h => h.trim());
    const data = [];
    for (let r = 1; r < rows.length; r++) {
      const obj = {};
      headers.forEach((h, idx) => {
        obj[h] = rows[r][idx] !== undefined ? rows[r][idx] : '';
      });
      data.push(obj);
    }
    return data;
  }

  const txns = parseCSV(fs.readFileSync(csvPath, 'utf8'));
  const res = engineModule.calculateMutualFundPositions(txns);
  const akEtm = res.positions.filter(p => p.subAccount === 'Ak ETMoney');
  console.log('Ak ETMoney Positions:');
  akEtm.forEach(p => console.log(p.status, '|', p.investmentAccount, '|', p.note || p.security, '|', p.isin, '| Units:', p.currentUnits, '| Cost:', p.remainingCostBasis));
}

check();
