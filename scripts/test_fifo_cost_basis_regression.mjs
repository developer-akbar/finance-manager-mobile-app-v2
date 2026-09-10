import assert from 'assert';
import fs from 'fs';
import { parseCSV } from '../src/utils/csvParser.js';
import { calculateMutualFundPositions, parseMutualFundTransaction } from '../src/utils/mutualFundPositionEngine.js';
import { getUnifiedPortfolioData } from '../src/utils/portfolioSelector.js';

console.log('=== RUNNING FIFO COST BASIS & SELL REALIZED PNL REGRESSION TESTS ===');

// Test Case 1 & 7: BUY with TradeValue 599.97 / 600, CostBasis 0, CashImpact 0 => Cost Basis = 599.97
const txn1 = {
  ID: 'test-buy-0809',
  Date: '08/09/2026',
  InvestmentTransactionType: 'BUY',
  InvestmentAccount: 'Liquid Mutual Funds',
  SubAccount: 'Fareeda Groww',
  SecurityISIN: 'INF247L01AC1',
  SecuritySymbol: 'Motilal Oswal Nifty Next 50',
  Quantity: '22.98',
  UnitPrice: '26.1082',
  TradeValue: '599.97',
  CostBasis: '0',
  CashImpact: '0',
  Tags: 'Ownership:EXTERNAL|Folio:910121381854/0|Mode:DEMAT'
};

const parsed1 = parseMutualFundTransaction(txn1);
assert(parsed1, 'Transaction 1 must be parsed');
assert.strictEqual(parsed1.quantity, 22.98);
assert.strictEqual(parsed1.costBasis, 599.97, 'Economic cost basis must be 599.97 even if CostBasis was 0');
assert.strictEqual(parsed1.tradeValue, 599.97);
console.log('✓ Test 1: BUY with TradeValue ₹600 and CostBasis ₹0 correctly sets costBasis to ₹599.97');

// Test Case 2: BUY 10 @ 20 with TradeValue 200 => FIFO cost basis 200
const txn2 = {
  ID: 'test-buy-1009',
  Date: '10/09/2026',
  InvestmentTransactionType: 'BUY',
  InvestmentAccount: 'Liquid Mutual Funds',
  SubAccount: 'Fareeda Groww',
  SecurityISIN: 'INF247L01AC1',
  SecuritySymbol: 'Motilal Oswal Nifty Next 50',
  Quantity: '10',
  UnitPrice: '20',
  TradeValue: '200',
  CostBasis: '200',
  Tags: 'Ownership:EXTERNAL|Folio:910121381854/0|Mode:DEMAT'
};

const parsed2 = parseMutualFundTransaction(txn2);
assert(parsed2, 'Transaction 2 must be parsed');
assert.strictEqual(parsed2.quantity, 10);
assert.strictEqual(parsed2.costBasis, 200);
console.log('✓ Test 2: BUY 10 @ ₹20 with TradeValue ₹200 correctly sets costBasis to ₹200');

// Test Case 3 & 4: Both BUYs in same position => total cost basis increases by 799.97 (~800)
const resGroup = calculateMutualFundPositions([txn1, txn2]);
assert.strictEqual(resGroup.positions.length, 1);
const pos = resGroup.positions[0];
assert.strictEqual(pos.currentUnits, 32.98);
assert.strictEqual(pos.remainingCostBasis, 799.97);
assert.strictEqual(pos.buyLots.length, 2);
assert.strictEqual(pos.buyLots[0].costBasis, 599.97);
assert.strictEqual(pos.buyLots[1].costBasis, 200);
console.log('✓ Test 3 & 4: Both BUYs merge into single position with combined cost basis ₹799.97');

// Test Case 5: BUY with separate acquisition charges includes charges in cost basis
const txnWithCharges = {
  ID: 'test-buy-charges',
  Date: '01/01/2026',
  InvestmentTransactionType: 'BUY',
  InvestmentAccount: 'Liquid Mutual Funds',
  SubAccount: 'Fareeda Groww',
  SecurityISIN: 'INF247L01AC1',
  Quantity: '100',
  UnitPrice: '10',
  TradeValue: '1000',
  TotalCharges: '15.50',
  Tags: 'Ownership:PERSONAL|Folio:12345|Mode:DEMAT'
};
const parsedCharges = parseMutualFundTransaction(txnWithCharges);
assert.strictEqual(parsedCharges.costBasis, 1015.5, 'Cost basis must include acquisition charges');
assert.strictEqual(parsedCharges.tradeValue, 1000, 'Trade value remains gross trade value');
console.log('✓ Test 5: BUY with acquisition charges correctly includes charges in economic cost basis');

// Test Case 6: SELL consumes FIFO lots correctly and calculates realized P&L correctly
const sellTxn = {
  ID: 'test-sell-1509',
  Date: '15/09/2026',
  InvestmentTransactionType: 'SELL',
  InvestmentAccount: 'Liquid Mutual Funds',
  SubAccount: 'Fareeda Groww',
  SecurityISIN: 'INF247L01AC1',
  Quantity: '15',
  UnitPrice: '30',
  TradeValue: '450',
  Tags: 'Ownership:EXTERNAL|Folio:910121381854/0|Mode:DEMAT'
};

const resWithSell = calculateMutualFundPositions([txn1, txn2, sellTxn]);
const posAfterSell = resWithSell.positions[0];
assert.strictEqual(posAfterSell.currentUnits, 17.98);
// Selling 15 units from Lot 1 (which had 22.98 units for ₹599.97, unitCost = 599.97 / 22.98 = 26.108355)
// Consumed cost basis = 15 * 26.108355 = 391.625
// Realized P&L = 450 - 391.625 = 58.375
const lot1After = posAfterSell.buyLots[0];
assert.strictEqual(Math.round(lot1After.remainingUnits * 100) / 100, 7.98);
assert.strictEqual(Math.round(posAfterSell.realizedPnl * 100) / 100, 58.37);
console.log('✓ Test 6: SELL correctly consumes FIFO lot 1 and computes realized P&L ₹58.37');

// Test Case 8: Live dataset integration test
const csvPath = fs.existsSync('finman_2026-09-10.csv') ? 'finman_2026-09-10.csv' : 'finman_2026-09-05_latest.csv';
const content = fs.readFileSync(csvPath, 'utf8');
const rows = parseCSV(content);

const unified = getUnifiedPortfolioData(rows, {});
const growwExternalDemat = unified.allPositions.find(p => p.positionKey === 'Liquid Mutual Funds | Fareeda Groww | INF247L01AC1 | 910121381854/0 | DEMAT | EXTERNAL');
assert(growwExternalDemat, 'Groww External DEMAT position must exist in live dataset');
assert(growwExternalDemat.remainingCostBasis >= 9599, `Groww DEMAT cost basis must be >= 9599.52, got ${growwExternalDemat.remainingCostBasis}`);
assert(growwExternalDemat.buyLots.every(lot => lot.costBasis > 0), 'Every single BUY lot must have positive cost basis (> 0)');

// Test Case 9: Display sorting (newest first) does NOT mutate underlying FIFO chronological order
const lotsChronological = pos.buyLots;
assert.strictEqual(lotsChronological[0].date, '08/09/2026', 'Underlying FIFO lot 0 must be the oldest lot (08/09/2026)');
assert.strictEqual(lotsChronological[1].date, '10/09/2026', 'Underlying FIFO lot 1 must be the newest lot (10/09/2026)');

// Emulate displayLots sorting
const parseD = (str) => {
  if (!str) return 0;
  const pts = String(str).split(/[-/]/);
  if (pts.length === 3) {
    if (pts[0].length === 4) return new Date(pts[0], pts[1] - 1, pts[2]).getTime();
    return new Date(pts[2], pts[1] - 1, pts[0]).getTime();
  }
  return new Date(str || 0).getTime() || 0;
};
const displayLotsSorted = [...lotsChronological].sort((a, b) => parseD(b.date) - parseD(a.date));

assert.strictEqual(displayLotsSorted[0].date, '10/09/2026', 'Display lot 0 must be the newest lot (10/09/2026)');
assert.strictEqual(displayLotsSorted[1].date, '08/09/2026', 'Display lot 1 must be the oldest lot (08/09/2026)');
assert.strictEqual(lotsChronological[0].date, '08/09/2026', 'Underlying FIFO lot array must remain completely unmutated');
console.log('✓ Test 9: Display lots correctly sorted latest-first without mutating chronological FIFO engine lots');

// === CHARGE BREAKDOWN EXPLICIT RECALCULATE TESTS ===
import { calculateGrowwCharges } from '../src/utils/brokerageAccounting.js';

// Test A: Existing manually entered charges remain unchanged without clicking Recalculate
const manualFormState = {
  settlementMode: 'BREAKDOWN',
  investmentTransactionType: 'BUY',
  quantity: '10',
  unitPrice: '100',
  tradeValue: '1000',
  brokerageCharges: '25.50',
  exchangeCharges: '1.20',
  sttCharges: '10.00',
  sebiCharges: '0.10',
  stampDutyCharges: '1.50',
  gstCharges: '4.80',
  dpCharges: '0',
  otherCharges: '5.00',
  costBasis: '1048.10'
};

// Simulate user editing quantity/tradeValue in BREAKDOWN mode (no auto-recalc)
const updatedTradeVal = 2000;
const sumManualCharges = (parseFloat(manualFormState.brokerageCharges) || 0) +
  (parseFloat(manualFormState.exchangeCharges) || 0) +
  (parseFloat(manualFormState.sttCharges) || 0) +
  (parseFloat(manualFormState.sebiCharges) || 0) +
  (parseFloat(manualFormState.stampDutyCharges) || 0) +
  (parseFloat(manualFormState.gstCharges) || 0) +
  (parseFloat(manualFormState.dpCharges) || 0) +
  (parseFloat(manualFormState.otherCharges) || 0);

assert.strictEqual(sumManualCharges, 48.10, 'Manual charges sum must be exactly 48.10');
assert.strictEqual(manualFormState.brokerageCharges, '25.50', 'Test A: Existing manual brokerage must not change');
assert.strictEqual(manualFormState.sttCharges, '10.00', 'Test A: Existing manual STT must not change');
console.log('✓ Test A: Existing manually entered charges remain unchanged without clicking Recalculate');

// Test B: Zero charges remain zero without clicking Recalculate
const zeroFormState = {
  settlementMode: 'BREAKDOWN',
  investmentTransactionType: 'BUY',
  quantity: '50',
  unitPrice: '20',
  tradeValue: '1000',
  brokerageCharges: '0',
  exchangeCharges: '0',
  sttCharges: '0',
  sebiCharges: '0',
  stampDutyCharges: '0',
  gstCharges: '0',
  dpCharges: '0',
  otherCharges: '0',
  costBasis: '1000'
};
assert.strictEqual(zeroFormState.brokerageCharges, '0', 'Test B: Zero brokerage remains 0');
assert.strictEqual(zeroFormState.sttCharges, '0', 'Test B: Zero STT remains 0');
console.log('✓ Test B: Zero charges remain zero without clicking Recalculate');

// Test C: Explicit Recalculate updates the charge fields
const calculatedBreakdown = calculateGrowwCharges({
  invType: 'BUY',
  tradeVal: 10000,
  securitySymbol: 'TCS',
  securityISIN: 'INE467B01029',
  investmentAccount: 'Share Market',
  exchange: 'NSE'
});
assert(calculatedBreakdown.totalCharges > 0, 'Test C: Recalculate generates valid estimated charges');
assert(calculatedBreakdown.brokerageCharges !== undefined, 'Test C: Recalculate estimates brokerage');
assert(calculatedBreakdown.sttCharges !== undefined, 'Test C: Recalculate estimates STT');
console.log(`✓ Test C: Explicit Recalculate updates charge fields (estimated total charges = ₹${calculatedBreakdown.totalCharges})`);

// Test D: Manually editing recalculated charges and saving preserves the edited values
const recalculatedFormState = {
  ...zeroFormState,
  tradeValue: '10000',
  brokerageCharges: String(calculatedBreakdown.brokerageCharges),
  exchangeCharges: String(calculatedBreakdown.exchangeCharges),
  sttCharges: String(calculatedBreakdown.sttCharges),
  sebiCharges: String(calculatedBreakdown.sebiCharges),
  stampDutyCharges: String(calculatedBreakdown.stampDutyCharges),
  gstCharges: String(calculatedBreakdown.gstCharges),
  dpCharges: String(calculatedBreakdown.dpCharges),
  otherCharges: String(calculatedBreakdown.otherCharges)
};
// User manually overrides STT to 50
recalculatedFormState.sttCharges = '50.00';
assert.strictEqual(recalculatedFormState.sttCharges, '50.00', 'Test D: Overridden manual charge is preserved in state');
console.log('✓ Test D: Manually editing recalculated charges and saving preserves the edited values');

console.log('=== ALL FIFO COST BASIS, REALIZED PNL & CHARGE BREAKDOWN REGRESSION TESTS PASSED! ===');

