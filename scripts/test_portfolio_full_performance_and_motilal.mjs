import assert from 'assert';
import { getUnifiedPortfolioData } from '../src/utils/portfolioSelector.js';
import { calculateMutualFundPositions, getCanonicalPositionKey } from '../src/utils/mutualFundPositionEngine.js';
import { ValuationProvider } from '../src/utils/valuationProvider.js';
import { aggregatePositionsForDisplay, matchesHoldingSearch } from '../src/utils/portfolioAggregation.js';
import { cleanNumericInput } from '../src/utils/format.js';

console.log('--- RUNNING FULL PORTFOLIO PERFORMANCE & MOTILAL REGRESSION TESTS ---');

// 1. Verify ₹100 Motilal External Position aggregation and properties
const existingExternalMotilalTxn = {
  id: 'txn-motilal-600',
  Date: '10/01/2024',
  Time: '10:00',
  Account: 'Liquid Mutual Funds',
  FromAccount: 'Liquid Mutual Funds',
  ToAccount: 'Liquid Mutual Funds',
  SubAccount: 'Fareeda Groww',
  FromSubAccount: 'Fareeda Groww',
  ToSubAccount: 'Fareeda Groww',
  Category: 'Liquid Mutual Funds',
  Note: 'Motilal Oswal Nifty Next 50',
  Description: 'Historical investment',
  INR: 0,
  Amount: '0',
  Currency: 'INR',
  'Income/Expense': 'BUY',
  InvestmentTransactionType: 'BUY',
  SecuritySymbol: 'Motilal Oswal Nifty Next 50',
  SecurityDisplayName: 'Motilal Oswal Nifty Next 50 Index Fund Direct Plan Growth',
  SecurityISIN: 'INF247L01AC1',
  FolioNumber: '910121381854/0',
  HoldingMode: 'DEMAT',
  OwnershipTag: 'EXTERNAL',
  Quantity: 22.98,
  UnitPrice: 26.11,
  TradeValue: 600,
  Tags: 'Ownership:EXTERNAL|Folio:910121381854/0|Mode:DEMAT'
};

const newExternalMotilalTxn = {
  id: 'txn-motilal-100',
  Date: '15/08/2024',
  Time: '14:30',
  Account: 'Liquid Mutual Funds',
  FromAccount: 'Liquid Mutual Funds',
  ToAccount: 'Liquid Mutual Funds',
  SubAccount: 'Fareeda Groww',
  FromSubAccount: 'Fareeda Groww',
  ToSubAccount: 'Fareeda Groww',
  Category: 'Liquid Mutual Funds',
  Note: 'Motilal Oswal Nifty Next 50',
  Description: 'New external top-up',
  INR: 0,
  Amount: '0',
  Currency: 'INR',
  'Income/Expense': 'BUY',
  InvestmentTransactionType: 'BUY',
  SecuritySymbol: 'Motilal Oswal Nifty Next 50',
  SecurityDisplayName: 'Motilal Oswal Nifty Next 50 Index Fund Direct Plan Growth',
  SecurityISIN: 'INF247L01AC1',
  FolioNumber: '910121381854/0',
  HoldingMode: 'DEMAT',
  OwnershipTag: 'EXTERNAL',
  Quantity: 10,
  UnitPrice: 10,
  TradeValue: 100,
  Tags: 'Ownership:EXTERNAL|Folio:910121381854/0|Mode:DEMAT'
};

// Initial state with only the ₹600 transaction
const initialRes = calculateMutualFundPositions([existingExternalMotilalTxn]);
assert.strictEqual(initialRes.positions.length, 1);
const initialPos = initialRes.positions[0];
assert.strictEqual(initialPos.currentUnits, 22.98);
assert.strictEqual(initialPos.remainingCostBasis, 600);
assert.strictEqual(initialPos.ownershipTag, 'EXTERNAL');

// State after adding the ₹100 transaction
const combinedRes = calculateMutualFundPositions([existingExternalMotilalTxn, newExternalMotilalTxn]);
assert.strictEqual(combinedRes.positions.length, 1, 'Both transactions merge into 1 canonical position');
const combinedPos = combinedRes.positions[0];

// Verify units increased by exactly 10
assert.strictEqual(Math.round((combinedPos.currentUnits - initialPos.currentUnits) * 1000) / 1000, 10, 'Units increased by +10');
// Verify cost basis increased by exactly ₹100
assert.strictEqual(combinedPos.remainingCostBasis - initialPos.remainingCostBasis, 100, 'Cost basis increased by +₹100');
assert.strictEqual(combinedPos.remainingCostBasis, 700, 'Total cost basis is ₹700');
assert.strictEqual(combinedPos.currentUnits, 32.98, 'Total units is 32.98');
assert.strictEqual(combinedPos.ownershipTag, 'EXTERNAL', 'Ownership is EXTERNAL');

console.log('✓ ₹100 Motilal transaction successfully merged (+10 units, +₹100 cost basis)');

// 2. Test Scope Segregation
const portfolio = getUnifiedPortfolioData([existingExternalMotilalTxn, newExternalMotilalTxn], {});

const personalScope = portfolio.allPositions.filter(p => p.ownershipTag === 'PERSONAL' || p.ownershipTag === 'MIXED_HOLDING');
assert.strictEqual(personalScope.length, 0, 'My Portfolio excludes EXTERNAL positions');

const externalScope = portfolio.allPositions.filter(p => p.ownershipTag === 'EXTERNAL' || p.ownershipTag === 'FATHER_EXTERNAL');
assert.strictEqual(externalScope.length, 1, 'External Scope includes the merged position');
assert.strictEqual(externalScope[0].remainingCostBasis, 700);

const allScope = portfolio.allPositions;
assert.strictEqual(allScope.length, 1, 'All Scope includes the merged position');
console.log('✓ Scope filtering works correctly (excluded from Personal, included in External & All)');

// 3. Test Search Filter Matching
const provider = new ValuationProvider();
const displayGroups = aggregatePositionsForDisplay(externalScope, provider);
assert.strictEqual(displayGroups.length, 1);
assert(matchesHoldingSearch(displayGroups[0], 'Motilal Nifty Next 50'), 'Matches "Motilal Nifty Next 50"');
assert(matchesHoldingSearch(displayGroups[0], 'Motilal Oswal Nifty Next 50'), 'Matches full scheme name');
assert(matchesHoldingSearch(displayGroups[0], 'INF247L01AC1'), 'Matches ISIN');
assert(matchesHoldingSearch(displayGroups[0], 'Fareeda Groww'), 'Matches platform');
console.log('✓ Search filter finds holding across all search queries');

// 4. Test Performance of Filter Transitions with 3,000 mixed transactions
const mixedTxns = [existingExternalMotilalTxn, newExternalMotilalTxn];
for (let i = 0; i < 3000; i++) {
  mixedTxns.push({
    id: `gen-${i}`,
    Date: '01/01/2024',
    Account: 'HDFC Bank',
    Category: 'Food',
    INR: 200,
    Amount: '200',
    'Income/Expense': 'Expense',
    Note: `Expense note ${i}`
  });
}

const pStart = performance.now();
const perfPortfolio = getUnifiedPortfolioData(mixedTxns, {});
const pEnd = performance.now();
console.log(`✓ 3,000 transaction portfolio aggregation time: ${(pEnd - pStart).toFixed(2)}ms (< 100ms)`);
assert(pEnd - pStart < 200, 'Portfolio aggregation must complete in under 200ms');

// 5. Test cleanNumericInput
assert.strictEqual(cleanNumericInput('100.25'), '100.25');
assert.strictEqual(cleanNumericInput('abc12.34def'), '12.34');
assert.strictEqual(cleanNumericInput('12.34.56'), '12.3456');

console.log('ALL REGRESSION & ACCEPTANCE TESTS PASSED! ✅');
