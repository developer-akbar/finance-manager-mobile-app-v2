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

async function testAllScope() {
  const { calculateMutualFundPositions } = await import('../src/utils/mutualFundPositionEngine.js');
  const txns = parseCSV(fs.readFileSync('finman_2026-09-02.csv', 'utf8'));

  const res = calculateMutualFundPositions(txns);
  console.log('Total positions:', res.positions.length);

  const allActive = res.positions.filter(p => p.status === 'ACTIVE');
  console.log('All Active positions:', allActive.length);
  const allActiveCost = allActive.reduce((s, p) => s + p.remainingCostBasis, 0);
  console.log('All Active Cost:', allActiveCost);

  const personal = res.getPersonalPortfolio();
  const personalActive = personal.filter(p => p.status === 'ACTIVE');
  console.log('Personal Active positions:', personalActive.length);
  const personalActiveCost = personalActive.reduce((s, p) => s + p.remainingCostBasis, 0);
  console.log('Personal Active Cost:', personalActiveCost);

  console.log('\nActive positions grouped by investmentAccount and ownershipTag:');
  for (const p of allActive) {
    console.log(p.investmentAccount, '|', p.subAccount, '|', p.ownershipTag, '|', p.note || p.security, '| units:', p.currentUnits, '| cost:', p.remainingCostBasis);
  }
}

testAllScope();
