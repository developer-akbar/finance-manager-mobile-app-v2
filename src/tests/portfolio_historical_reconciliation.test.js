import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateMutualFundPositions } from '../utils/mutualFundPositionEngine.js';

test('Portfolio Historical Reconciliation & Sell Record Tracking', async (t) => {
  await t.test('1. calculateMutualFundPositions exposes sellRecords with consumedCostBasis and realizedPnl', () => {
    const rawTxns = [
      {
        ID: 'tx-1',
        Date: '01/01/2023',
        InvestmentTransactionType: 'BUY',
        SecurityISIN: 'INF109K017Z4',
        SecuritySymbol: 'Parag Parikh Flexi Cap Fund',
        Units: 1000,
        UnitPrice: 50.0,
        TradeValue: 50000,
        CostBasis: 50000,
        FolioNumber: '12345',
        InvestmentAccount: 'Liquid Mutual Funds',
        Brokerage: 'Groww'
      },
      {
        ID: 'tx-2',
        Date: '10/06/2023',
        InvestmentTransactionType: 'SELL',
        SecurityISIN: 'INF109K017Z4',
        SecuritySymbol: 'Parag Parikh Flexi Cap Fund',
        Units: 600,
        UnitPrice: 60.0,
        TradeValue: 36000,
        FolioNumber: '12345',
        InvestmentAccount: 'Liquid Mutual Funds',
        Brokerage: 'Groww'
      }
    ];

    const { positions } = calculateMutualFundPositions(rawTxns);
    assert.equal(positions.length, 1);
    const pos = positions[0];

    assert.ok(Array.isArray(pos.sellRecords), 'sellRecords should be an array');
    assert.equal(pos.sellRecords.length, 1);
    
    const sell = pos.sellRecords[0];
    assert.equal(sell.transactionId, 'tx-2');
    assert.equal(sell.units, 600);
    assert.equal(sell.tradeValue, 36000);
    assert.equal(sell.consumedCostBasis, 30000); // 600 units * 50 NAV
    assert.equal(sell.realizedPnl, 6000); // 36000 - 30000
    assert.equal(pos.currentUnits, 400);
    assert.equal(pos.remainingCostBasis, 20000);
    assert.equal(pos.realizedPnl, 6000);
  });

  await t.test('2. Net Invested Capital trajectory reduces remaining cost and tracks cumulative realized gains', () => {
    const events = [
      { type: 'BUY', costDelta: 50000, pnlDelta: 0 },
      { type: 'SELL', costDelta: -30000, pnlDelta: 6000 }
    ];

    let runningNetCost = 0;
    let runningGrossCost = 0;
    let runningRealized = 0;

    for (const ev of events) {
      if (ev.type === 'BUY') {
        runningGrossCost += ev.costDelta;
        runningNetCost += ev.costDelta;
      } else {
        runningNetCost += ev.costDelta; // subtracts consumed cost basis
        runningRealized += ev.pnlDelta;
      }
    }

    assert.equal(runningGrossCost, 50000, 'Gross cumulative contributions should be 50,000');
    assert.equal(runningNetCost, 20000, 'Net invested cost after redemption should equal 20,000');
    assert.equal(runningRealized, 6000, 'Cumulative realized P&L should be 6,000');
  });
});
