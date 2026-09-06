const fs = require('fs');
const { parseCSV } = require('../src/utils/csvParser.js');
const { calculateMutualFundPositions, parseMutualFundTransaction } = require('../src/utils/mutualFundPositionEngine.js');

const csvContent = fs.readFileSync('finman_2026-09-05.csv', 'utf8');
const transactions = parseCSV(csvContent);

const mfResult = calculateMutualFundPositions(transactions);
const liquidPositions = mfResult.positions.filter(p => p.investmentAccount === 'Liquid Mutual Funds' && p.ownershipTag !== 'FATHER_EXTERNAL');

console.log('--- LIQUID MF ALL POSITIONS (REDEEMED & ACTIVE) WITH PNL ---');
liquidPositions.forEach(p => {
  const sellCostBasis = p.sellCostBasis || p.buyCost || 0;
  const totalProceeds = p.totalProceeds || 0;
  const pnl = p.realizedPnl || 0;
  console.log(`Fund: ${p.note || p.security} (${p.subAccount})`);
  console.log(`  Status: ${p.status}, Active Units: ${p.currentUnits}, Sold Units: ${p.sellUnits}`);
  console.log(`  Sold Cost Basis: ₹${sellCostBasis.toFixed(2)}, Total Proceeds: ₹${totalProceeds.toFixed(2)}, Realized P&L: ₹${pnl.toFixed(2)}`);
});

console.log('\n--- CATEGORY TRANSACTIONS UNDER CATEGORY "Equity" / "Liquid Mutual Funds" / Subcategories "Liquid MF Gains" / "Liquid MF Losses" ---');
transactions.forEach(t => {
  const cat = t.Category || '';
  const sub = t.Subcategory || '';
  const note = t.Note || '';
  if (cat.includes('Liquid') || sub.includes('Liquid') || note.includes('Liquid')) {
    console.log(`Date: ${t.Date}, Note: "${t.Note}", Cat: "${t.Category}", Sub: "${t.Subcategory}", Type: "${t['Income/Expense']}", Amount: ₹${t.INR || t.Amount}`);
  }
});
