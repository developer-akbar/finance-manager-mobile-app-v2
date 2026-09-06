const fs = require('fs');
const path = require('path');
const { parseCSV } = require('../src/utils/csvParser.js');
const { calculateMutualFundPositions } = require('../src/utils/mutualFundPositionEngine.js');
const { getUnifiedPortfolioData } = require('../src/utils/portfolioSelector.js');

const rawCsv = fs.readFileSync(path.join(__dirname, '..', 'finman_2026-09-05.csv'), 'utf8');
const txns = parseCSV(rawCsv);

console.log('=== MUTUAL FUND POSITION INVENTORY AUDIT ===\n');

const portfolio = getUnifiedPortfolioData(txns);
const mfPositions = portfolio.mfPositions;

console.log(`Total Unified MF Positions: ${mfPositions.length}`);

const activeMf = mfPositions.filter(p => p.status === 'ACTIVE');
const redeemedMf = mfPositions.filter(p => p.status === 'REDEEMED');

console.log(`Active MF Positions: ${activeMf.length}`);
console.log(`Redeemed MF Positions: ${redeemedMf.length}`);

// Group Active MF Positions by Ownership Tag
const grouped = {
  'PERSONAL': [],
  'AMMI': [],
  'MIXED_HOLDING': [],
  'FATHER_EXTERNAL': []
};

activeMf.forEach(p => {
  const tag = p.ownershipTag || 'PERSONAL';
  if (!grouped[tag]) grouped[tag] = [];
  grouped[tag].push(p);
});

console.log('\n--- ACTIVE MUTUAL FUND POSITIONS BY SCOPE ---');
Object.keys(grouped).forEach(tag => {
  const list = grouped[tag];
  console.log(`\nGroup: ${tag} (${list.length} positions)`);
  let totalCost = 0;
  let totalUnits = 0;

  list.forEach((p, i) => {
    totalCost += p.remainingCostBasis || 0;
    totalUnits += p.currentUnits || 0;
    console.log(`  ${i+1}. [${p.investmentAccount}] Sub: ${p.subAccount || 'N/A'} | Security: ${p.security} | ISIN: ${p.isin || 'N/A'} | Folio: ${p.folioNumber} | Mode: ${p.holdingMode} | Units: ${p.currentUnits.toFixed(3)} | CostBasis: ₹${(p.remainingCostBasis || 0).toFixed(2)}`);
  });
  console.log(`  Subtotal Units: ${totalUnits.toFixed(3)} | Subtotal CostBasis: ₹${totalCost.toFixed(2)}`);
});

if (redeemedMf.length > 0) {
  console.log('\n--- REDEEMED MUTUAL FUND POSITIONS ---');
  redeemedMf.forEach((p, i) => {
    console.log(`  ${i+1}. [${p.investmentAccount}] Sub: ${p.subAccount || 'N/A'} | Security: ${p.security} | ISIN: ${p.isin || 'N/A'} | Folio: ${p.folioNumber} | RealizedPnl: ₹${p.realizedPnl.toFixed(2)}`);
  });
} else {
  console.log('\nRedeemed MF Positions: 0');
}

// Check Liquid Mutual Fund CAS holdings explicitly
console.log('\n--- LIQUID MUTUAL FUND POSITIONS DETAIL ---');
const liquidMf = mfPositions.filter(p => p.investmentAccount === 'Liquid Mutual Funds');
console.log(`Total Liquid Mutual Fund Positions: ${liquidMf.length}`);
liquidMf.forEach((p, i) => {
  console.log(`  ${i+1}. Sub: ${p.subAccount} | Security: ${p.security} | Folio: ${p.folioNumber} | Tag: ${p.ownershipTag} | Units: ${p.currentUnits} | CostBasis: ₹${p.remainingCostBasis}`);
});

// Check ETF deduplication
console.log('\n--- ETF DEDUPLICATION VERIFICATION ---');
const goldBeesInMf = mfPositions.find(p => (p.security || '').toUpperCase().includes('GOLD BEES') || p.isin === 'INF204KB17I5');
const silverBeesInMf = mfPositions.find(p => (p.security || '').toUpperCase().includes('SILVERBEES') || p.isin === 'INF204KC1402');

console.log(`Gold BeES in MF positions list? ${goldBeesInMf ? 'YES (ERROR)' : 'NO (DEDUPLICATED CORRECTLY)'}`);
console.log(`SilverBeES in MF positions list? ${silverBeesInMf ? 'YES (ERROR)' : 'NO (DEDUPLICATED CORRECTLY)'}`);

