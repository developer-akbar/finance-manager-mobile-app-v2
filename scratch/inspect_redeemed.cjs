const fs = require('fs');

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
    obj._line = r;
    data.push(obj);
  }
  return data;
}

async function inspectRedeemed() {
  const { calculateMutualFundPositions } = await import('../src/utils/mutualFundPositionEngine.js');
  const txns = parseCSV(fs.readFileSync('finman_2026-09-02.csv', 'utf8'));
  const res = calculateMutualFundPositions(txns);

  console.log('=== ALL POSITIONS ===');
  for (const p of res.positions) {
    console.log(`${p.status} | acct: ${p.investmentAccount} | sub: ${p.subAccount} | tag: ${p.ownershipTag} | isin: ${p.isin} | sec: ${p.security} | units: ${p.currentUnits} | cost: ${p.remainingCostBasis} | pnl: ${p.realizedPnl}`);
  }
}

inspectRedeemed();
