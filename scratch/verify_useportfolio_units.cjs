const fs = require('fs');
const { parseCSV } = require('../src/utils/csvParser.js');
const { getUnifiedPortfolioData } = require('../src/utils/portfolioSelector.js');

const csvContent = fs.readFileSync('finman_2026-09-05.csv', 'utf8');
const transactions = parseCSV(csvContent);

// Test usePortfolio logic directly
const rawPortfolio = getUnifiedPortfolioData(transactions);
const scopedPositions = rawPortfolio.allPositions.filter(p => p.ownershipTag === 'PERSONAL' || p.ownershipTag === 'MIXED_HOLDING');
const activeHoldings = scopedPositions.filter(p => p.status === 'ACTIVE');

const activeCost = activeHoldings.reduce((sum, p) => sum + (p.remainingCostBasis || 0), 0);
const activeUnits = activeHoldings.reduce((sum, p) => sum + (p.currentUnits || 0), 0);

console.log(`scopedPositions count: ${scopedPositions.length}`);
console.log(`activeHoldings count: ${activeHoldings.length}`);
console.log(`activeCost: ₹${activeCost.toFixed(2)} (formatted: ₹${Math.round(activeCost).toLocaleString('en-IN')})`);
console.log(`activeUnits: ${activeUnits.toFixed(3)} (formatted: ${activeUnits.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })})`);
