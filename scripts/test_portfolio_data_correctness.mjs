import assert from 'assert';
import fs from 'fs';
import { parseCSV } from '../src/utils/csvParser.js';
import { calculateMutualFundPositions, parseMutualFundTransaction } from '../src/utils/mutualFundPositionEngine.js';
import { calculateBrokerageState } from '../src/utils/brokerageAccounting.js';
import { getUnifiedPortfolioData } from '../src/utils/portfolioSelector.js';

console.log('=== RUNNING PORTFOLIO DATA CORRECTNESS REGRESSION TESTS ===');

// Load real data if available, or generate multi-account scenario
const csvPath = fs.existsSync('finman_2026-09-10.csv') 
  ? 'finman_2026-09-10.csv' 
  : (fs.existsSync('finman_2026-09-05_latest.csv') ? 'finman_2026-09-05_latest.csv' : null);

assert(csvPath, 'Authoritative live-app CSV dataset must exist');
const content = fs.readFileSync(csvPath, 'utf8');
const rows = parseCSV(content);

console.log(`Loaded dataset ${csvPath} with ${rows.length} rows.`);

// 1. Unified Portfolio Execution
const unified = getUnifiedPortfolioData(rows, {});

// Invariant 1: No duplicate transaction IDs across MF and Share Market
const mfTxnIds = new Set();
unified.mfPositions.forEach(p => {
  (p.txns || []).forEach(t => { if (t.id) mfTxnIds.add(t.id); });
});

const smTxnIds = new Set();
unified.shareMarketPositions.forEach(p => {
  (p.txns || []).forEach(t => { if (t.id) smTxnIds.add(t.id); });
});

const overlappingTxns = [...mfTxnIds].filter(id => smTxnIds.has(id));
console.log(`Invariant 1: Overlapping transaction IDs between MF and Share Market: ${overlappingTxns.length}`);
assert.strictEqual(overlappingTxns.length, 0, 'No transaction ID should ever be counted in both MF and Share Market');

// Invariant 2: Share Market positions are not duplicated as Mutual Funds
const mfShareMarketStocks = unified.mfPositions.filter(p => {
  const isin = String(p.isin || '').toUpperCase();
  const sec = String(p.security || p.note || '').toUpperCase();
  return isin.startsWith('INE') || sec.includes('TATAPOWER') || sec.includes('SUZLON') || sec.includes('DEVYANI');
});
console.log(`Invariant 2: Share Market stocks mistakenly parsed into MF engine: ${mfShareMarketStocks.length}`);
assert.strictEqual(mfShareMarketStocks.length, 0, 'Equity stocks must never be created as MF positions');

// Invariant 3: Active position count sanity check (not inflated to 49)
const activePositions = unified.allPositions.filter(p => p.status === 'ACTIVE' && (p.currentUnits || 0) > 0);
console.log(`Invariant 3: Active position count: ${activePositions.length}`);
assert(activePositions.length >= 30 && activePositions.length <= 38, `Active position count should be between 30 and 38, got ${activePositions.length}`);

// Invariant 4: Scope separation (Personal vs External)
const personalPositions = unified.allPositions.filter(p => p.ownershipTag === 'PERSONAL' || p.ownershipTag === 'MIXED_HOLDING');
const externalPositions = unified.allPositions.filter(p => p.ownershipTag === 'EXTERNAL' || p.ownershipTag === 'FATHER_EXTERNAL' || p.ownershipTag === 'EXTERNAL_FATHER');

console.log(`Invariant 4: Personal active: ${personalPositions.filter(p => p.status === 'ACTIVE').length}, External active: ${externalPositions.filter(p => p.status === 'ACTIVE').length}`);
assert(personalPositions.length > 0, 'Personal positions must exist');
assert(externalPositions.length > 0, 'External positions must exist');

// Invariant 5: Scope limits Accounts and Platforms correctly
const personalAccounts = new Set(personalPositions.map(p => p.investmentAccount).filter(Boolean));
const externalAccounts = new Set(externalPositions.map(p => p.investmentAccount).filter(Boolean));

console.log('Personal Accounts:', [...personalAccounts]);
console.log('External Accounts:', [...externalAccounts]);

assert(personalAccounts.has('Liquid Mutual Funds'), 'Personal should have Liquid Mutual Funds');
assert(personalAccounts.has('Mutual Funds Tax Saver'), 'Personal should have Mutual Funds Tax Saver');
assert(personalAccounts.has('Share Market'), 'Personal should have Share Market');

assert(externalAccounts.has('Liquid Mutual Funds'), 'External should have Liquid Mutual Funds');
assert(!externalAccounts.has('Share Market'), 'External should NOT leak Share Market');
assert(!externalAccounts.has('Mutual Funds Tax Saver'), 'External should NOT leak Mutual Funds Tax Saver');

// Invariant 6: Platform cascading under Account
const lmfPlatformsPersonal = new Set(
  personalPositions.filter(p => p.investmentAccount === 'Liquid Mutual Funds').map(p => p.subAccount).filter(Boolean)
);
console.log('Liquid Mutual Funds Platforms (Personal):', [...lmfPlatformsPersonal]);
assert(!lmfPlatformsPersonal.has('Zerodha'), 'Zerodha should NOT appear under Liquid Mutual Funds');

const smPlatformsPersonal = new Set(
  personalPositions.filter(p => p.investmentAccount === 'Share Market').map(p => p.subAccount).filter(Boolean)
);
console.log('Share Market Platforms (Personal):', [...smPlatformsPersonal]);
assert(smPlatformsPersonal.has('Zerodha'), 'Zerodha must appear under Share Market');

// Invariant 7: External Motilal ₹100 transaction merges cleanly into existing position
const motilalDematBefore = externalPositions.find(p => p.positionKey === 'Liquid Mutual Funds | Fareeda Groww | INF247L01AC1 | 910121381854/0 | DEMAT | EXTERNAL');
assert(motilalDematBefore, 'External Motilal DEMAT position must exist');
const initialUnits = motilalDematBefore.currentUnits;
const initialCost = motilalDematBefore.remainingCostBasis;
const initialTxnCount = motilalDematBefore.txns.length;

const new100Txn = {
  id: 'regression-test-motilal-100-txn',
  ID: 'regression-test-motilal-100-txn',
  Date: '10/09/2026',
  Account: 'Canara',
  ToAccount: 'Liquid Mutual Funds',
  InvestmentAccount: 'Liquid Mutual Funds',
  SubAccount: 'Fareeda Groww',
  Brokerage: 'Fareeda Groww',
  Category: 'Liquid Mutual Funds',
  Note: 'Motilal Oswal Nifty Next 50',
  Description: 'Motilal Oswal Nifty Next 50',
  INR: '100',
  Amount: '100',
  'Income/Expense': 'BUY',
  InvestmentTransactionType: 'BUY',
  SecurityISIN: 'INF247L01AC1',
  SecuritySymbol: 'Motilal Oswal Nifty Next 50',
  Quantity: '10',
  UnitPrice: '10',
  TradeValue: '100',
  CostBasis: '100',
  Tags: 'Ownership:EXTERNAL|Folio:910121381854/0|Mode:DEMAT',
  OwnershipTag: 'EXTERNAL',
  FolioNumber: '910121381854/0',
  HoldingMode: 'DEMAT'
};

const unifiedWithNew = getUnifiedPortfolioData([...rows, new100Txn], {});
const motilalDematAfter = unifiedWithNew.allPositions.find(p => p.positionKey === 'Liquid Mutual Funds | Fareeda Groww | INF247L01AC1 | 910121381854/0 | DEMAT | EXTERNAL');

assert(motilalDematAfter, 'External Motilal DEMAT position must exist after adding txn');
assert.strictEqual(Math.round((motilalDematAfter.currentUnits - initialUnits) * 1000) / 1000, 10, 'Units must increase by exactly 10');
assert.strictEqual(Math.round((motilalDematAfter.remainingCostBasis - initialCost) * 100) / 100, 100, 'Cost basis must increase by exactly 100');
assert.strictEqual(motilalDematAfter.txns.length, initialTxnCount + 1, 'Transaction count must increase by 1');

// Ensure no duplicate card was created
const allMotilalFareedaGroww = unifiedWithNew.allPositions.filter(p => p.subAccount === 'Fareeda Groww' && p.isin === 'INF247L01AC1' && p.ownershipTag === 'EXTERNAL' && p.holdingMode === 'DEMAT');
assert.strictEqual(allMotilalFareedaGroww.length, 1, 'Exactly one Motilal DEMAT card must exist in External scope');

console.log('=== ALL PORTFOLIO DATA CORRECTNESS INVARIANTS PASSED SUCCESSFULLY ===');
