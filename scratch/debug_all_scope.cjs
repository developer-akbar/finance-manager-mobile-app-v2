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

async function run() {
  const { calculateMutualFundPositions } = await import('../src/utils/mutualFundPositionEngine.js');
  const txns = parseCSV(fs.readFileSync('finman_2026-09-02.csv', 'utf8'));
  const res = calculateMutualFundPositions(txns);

  console.log('Total positions:', res.positions.length);
  const active = res.positions.filter(p => p.status === 'ACTIVE');
  console.log('Active count:', active.length);

  const personal = res.getPersonalPortfolio();
  const personalActive = personal.filter(p => p.status === 'ACTIVE');
  console.log('Personal Active count:', personalActive.length);

  const father = res.positions.filter(p => p.ownershipTag === 'FATHER_EXTERNAL');
  const fatherActive = father.filter(p => p.status === 'ACTIVE');
  console.log('Father Active count:', fatherActive.length);

  console.log('\nAll Active positions breakdown:');
  for (const p of active) {
    console.log(`${p.investmentAccount} | ${p.subAccount} | ${p.ownershipTag} | ${p.note || p.security} | units: ${p.currentUnits} | cost: ${p.remainingCostBasis}`);
  }
}

run();
