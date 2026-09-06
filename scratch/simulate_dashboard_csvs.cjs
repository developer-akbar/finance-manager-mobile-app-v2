const fs = require('fs');
const path = require('path');

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

async function simulateDashboard(csvFile) {
  console.log(`\n========================================`);
  console.log(`Simulating Dashboard with ${csvFile}`);
  console.log(`========================================`);
  
  const { calculateMutualFundPositions } = await import('../src/utils/mutualFundPositionEngine.js');
  const txns = parseCSV(fs.readFileSync(path.resolve(csvFile), 'utf8'));
  
  // Exactly as in InvestmentsPortfolio.jsx
  const engineResult = calculateMutualFundPositions(txns);
  
  // Scope: personal (default)
  const scopedPositions = engineResult.getPersonalPortfolio();
  
  // Platform: all, Account: all
  const displayedPositions = scopedPositions;
  
  const activeHoldings = displayedPositions.filter(p => p.status === 'ACTIVE');
  const activeCost = activeHoldings.reduce((sum, p) => sum + p.remainingCostBasis, 0);
  const platforms = new Set(displayedPositions.map(p => p.subAccount).filter(Boolean));
  
  console.log(`Total Positions from Engine: ${engineResult.positions.length}`);
  console.log(`Scoped Positions (Personal): ${scopedPositions.length}`);
  console.log(`Active Holdings: ${activeHoldings.length}`);
  console.log(`Active Invested Principal: Rs. ${Math.round(activeCost).toLocaleString('en-IN')}`);
  console.log(`Platforms (${platforms.size}):`, Array.from(platforms));
  
  console.log('\nBreakdown of Active Holdings by InvestmentAccount and SubAccount:');
  const byAcctSub = {};
  for (const p of activeHoldings) {
    const k = `${p.investmentAccount} > ${p.subAccount}`;
    byAcctSub[k] = (byAcctSub[k] || 0) + 1;
  }
  console.log(byAcctSub);
}

async function run() {
  await simulateDashboard('finman_2026-09-01.csv');
  await simulateDashboard('finman_2026-09-02.csv');
}

run();
