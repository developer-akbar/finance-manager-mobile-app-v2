import assert from 'assert';
import { parseMutualFundTransaction, calculateMutualFundPositions } from '../src/utils/mutualFundPositionEngine.js';
import { getUnifiedPortfolioData } from '../src/utils/portfolioSelector.js';
import { 
  aggregatePositionsForDisplay,
  matchesHoldingSearch 
} from '../src/utils/portfolioAggregation.js';
import { resolveSecurity } from '../src/utils/securityResolution.js';

console.log('--- RUNNING PORTFOLIO SEARCH REGRESSION TEST FOR MOTILAL NIFTY NEXT 50 ---');

// 1. Existing EXTERNAL transaction for Motilal Nifty Next 50
const externalTxn = {
  id: 'txn-ext-1',
  Date: '01/05/2024',
  Account: 'Liquid Mutual Funds',
  FromAccount: 'Liquid Mutual Funds',
  ToAccount: 'Liquid Mutual Funds',
  Category: 'Liquid Mutual Funds',
  Note: 'Motilal Oswal Nifty Next 50',
  Description: 'Mutual Fund Purchase: Motilal Oswal Nifty Next 50 | Folio: 910121381854/0',
  INR: 0,
  Amount: '0',
  'Income/Expense': 'Transfer-Out',
  InvestmentAccount: 'Liquid Mutual Funds',
  SubAccount: 'Fareeda Groww',
  Brokerage: 'Fareeda Groww',
  InvestmentTransactionType: 'BUY',
  SecuritySymbol: 'Motilal Nifty Next 50',
  SecurityDisplayName: 'Motilal Oswal Nifty Next 50',
  SecurityISIN: 'INF247L01AC1',
  HoldingMode: 'DEMAT',
  FolioNumber: '910121381854/0',
  OwnershipTag: 'EXTERNAL',
  Quantity: 22.980,
  UnitPrice: 26.1082,
  TradeValue: 600,
  CostBasis: 600,
  RealizedPnl: 0,
  Tags: 'Ownership:EXTERNAL|Folio:910121381854/0|Mode:DEMAT'
};

// 2. Newly created PERSONAL transaction for Motilal Nifty Next 50
const personalTxn = {
  id: 'txn-pers-1',
  Date: '09/09/2026',
  Account: 'Liquid Mutual Funds',
  FromAccount: 'Liquid Mutual Funds',
  ToAccount: 'Liquid Mutual Funds',
  Category: 'Liquid Mutual Funds',
  Note: 'Motilal Nifty Next 50',
  Description: '',
  INR: 100,
  Amount: '100',
  'Income/Expense': 'Transfer-Out',
  InvestmentAccount: 'Liquid Mutual Funds',
  SubAccount: 'Fareeda Groww',
  Brokerage: 'Fareeda Groww',
  InvestmentTransactionType: 'BUY',
  SecuritySymbol: 'Motilal Nifty Next 50',
  SecurityDisplayName: 'Motilal Oswal Nifty Next 50',
  SecurityISIN: 'INF247L01AC1',
  HoldingMode: 'DEMAT',
  FolioNumber: '',
  OwnershipTag: 'PERSONAL',
  Quantity: 10,
  UnitPrice: 10,
  TradeValue: 100,
  CostBasis: 100,
  RealizedPnl: 0,
  Tags: 'Ownership:PERSONAL'
};

const allTransactions = [externalTxn, personalTxn];

// 3. Test Unified Portfolio Data
const portfolioData = getUnifiedPortfolioData(allTransactions, {});
const { allPositions } = portfolioData;

assert.strictEqual(allPositions.length, 2, 'Must have 2 separate positions (1 External, 1 Personal)');

const personalPositions = allPositions.filter(p => p.ownershipTag === 'PERSONAL' || p.ownershipTag === 'MIXED_HOLDING');
const externalPositions = allPositions.filter(p => p.ownershipTag === 'EXTERNAL' || p.ownershipTag === 'FATHER_EXTERNAL');

// Assertions on Personal Scope
assert.strictEqual(personalPositions.length, 1, 'My Portfolio (Personal Scope) must contain exactly 1 position');
assert.strictEqual(personalPositions[0].currentUnits, 10, 'Personal units must be 10');
assert.strictEqual(personalPositions[0].remainingCostBasis, 100, 'Personal cost basis must be ₹100');
assert.strictEqual(personalPositions[0].ownershipTag, 'PERSONAL', 'Ownership must be PERSONAL');

// Assertions on External Scope
assert.strictEqual(externalPositions.length, 1, 'External scope must contain exactly 1 position');
assert.strictEqual(externalPositions[0].currentUnits, 22.980, 'External units must be 22.980');
assert.strictEqual(externalPositions[0].remainingCostBasis, 600, 'External cost basis must be ₹600');
assert.strictEqual(externalPositions[0].ownershipTag, 'EXTERNAL', 'Ownership must be EXTERNAL');

// 4. Test Aggregation & HoldingsTable Search Filtering in Personal Scope
const personalGroups = aggregatePositionsForDisplay(personalPositions);
assert.strictEqual(personalGroups.length, 1, 'Personal aggregated groups count must be 1');

// Test search queries on Personal Holdings
const searchQueries = [
  'Motilal Nifty Next 50',
  'motilal nifty next 50',
  'Motilal Oswal Nifty Next 50',
  'Motilal Next 50',
  'motilal',
  'Nifty Next 50',
  'INF247L01AC1',
  'Fareeda Groww'
];

for (const q of searchQueries) {
  const matches = personalGroups.filter(g => matchesHoldingSearch(g, q));
  assert.strictEqual(matches.length, 1, `Query "${q}" must match the personal Motilal position`);
  console.log(`✓ Personal search matching "${q}": Found ${matches.length} holding`);
}

// Ensure unrelated search does NOT match
const unrelatedMatches = personalGroups.filter(g => matchesHoldingSearch(g, 'HDFC Bank'));
assert.strictEqual(unrelatedMatches.length, 0, 'Unrelated search must return 0 results');
console.log('✓ Unrelated search returns 0 results');

// 5. Test Search Filtering in External Scope
const externalGroups = aggregatePositionsForDisplay(externalPositions);
assert.strictEqual(externalGroups.length, 1, 'External aggregated groups count must be 1');

const extMatches = externalGroups.filter(g => matchesHoldingSearch(g, 'Motilal Nifty Next 50'));
assert.strictEqual(extMatches.length, 1, 'Searching Motilal Nifty Next 50 in External scope finds External holding');
assert.strictEqual(extMatches[0].ownershipTag, 'EXTERNAL', 'External group has EXTERNAL ownership');
console.log('✓ External search matching "Motilal Nifty Next 50": Found 1 holding');

// 6. Test Search Filtering in All Scope
const allGroups = aggregatePositionsForDisplay(allPositions);
assert.strictEqual(allGroups.length, 2, 'All scope must have 2 separate aggregated groups (Personal + External)');

const allMatches = allGroups.filter(g => matchesHoldingSearch(g, 'Motilal Nifty Next 50'));
assert.strictEqual(allMatches.length, 2, 'Searching in All scope finds both Personal and External holdings');
console.log('✓ All scope search matching "Motilal Nifty Next 50": Found 2 holdings');

// 7. Test Transaction with Missing ISIN Auto-Resolution & Inclusion
const txnWithoutISIN = {
  id: 'txn-no-isin',
  Date: '09/09/2026',
  Account: 'Liquid Mutual Funds',
  FromAccount: 'Liquid Mutual Funds',
  ToAccount: 'Liquid Mutual Funds',
  Category: 'Liquid Mutual Funds',
  Note: 'Motilal Nifty Next 50',
  'Income/Expense': 'Transfer-Out',
  InvestmentAccount: 'Liquid Mutual Funds',
  SubAccount: 'Fareeda Groww',
  InvestmentTransactionType: 'BUY',
  SecuritySymbol: 'Motilal Nifty Next 50',
  OwnershipTag: 'PERSONAL',
  Quantity: 5,
  UnitPrice: 10,
  TradeValue: 50,
  CostBasis: 50
};

const parsedNoIsin = parseMutualFundTransaction(txnWithoutISIN);
assert.strictEqual(parsedNoIsin.isin, 'INF247L01AC1', 'parseMutualFundTransaction auto-resolves missing ISIN via alias');

const mfResNoIsin = calculateMutualFundPositions([txnWithoutISIN]);
assert.strictEqual(mfResNoIsin.positions.length, 1, 'calculateMutualFundPositions includes transaction with missing explicit ISIN');
console.log('✓ Missing ISIN auto-resolved and position generated');

console.log('\nALL PORTFOLIO SEARCH REGRESSION TESTS PASSED! ✅');
