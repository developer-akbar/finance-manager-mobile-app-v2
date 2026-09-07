import { calculateMutualFundPositions } from './mutualFundPositionEngine.js';
import { calculateBrokerageState } from './brokerageAccounting.js';

/**
 * Single Unified Portfolio Data Aggregator
 * 
 * Combines Mutual Fund positions (from mutualFundPositionEngine) and
 * Share Market holdings & brokerage cash (from brokerageAccounting)
 * into a single unified position model without mutating accounting state.
 * 
 * @param {Array} transactions Array of FinMan transactions
 * @param {Object} settings Application settings object
 * @returns {Object} { allPositions, mfPositions, shareMarketPositions, brokerageCashMap, totalBrokerageCash }
 */
export function getUnifiedPortfolioData(transactions = [], settings = {}) {
  // 1. Calculate Mutual Fund Positions
  const mfResult = calculateMutualFundPositions(transactions);
  const mfPositions = mfResult.positions || [];

  // 2. Calculate Share Market Brokerage State
  const brokerageStateMap = calculateBrokerageState(transactions, [], settings);

  const shareMarketPositions = [];
  const brokerageCashMap = {};

  Object.entries(brokerageStateMap).forEach(([broker, data]) => {
    if (!broker) return;

    // Segregated Brokerage Cash Balance
    brokerageCashMap[broker] = Math.round((data.cash || 0) * 100) / 100;

    // Active Share Market Holdings
    (data.activeHoldings || []).forEach(h => {
      if (!h || !h.symbol) return;

      const positionKey = `Share Market | ${broker} | ${h.symbol} | DEMAT`;
      const currentUnits = parseFloat(h.qty) || 0;
      const remainingCostBasis = parseFloat(h.investedCost) || 0;
      const avgCost = currentUnits > 0 ? remainingCostBasis / currentUnits : 0;
      const currentPrice = h.currentPrice > 0 ? h.currentPrice : null;
      const currentValue = h.currentValue > 0 ? h.currentValue : null;

      const firstBuyDate = h.firstBuyDate || (h.txns && h.txns.length > 0 ? (h.txns[0].date || h.txns[0].Date || '') : '');
      const lastTransactionDate = h.lastTransactionDate || (h.txns && h.txns.length > 0 ? (h.txns[h.txns.length - 1].date || h.txns[h.txns.length - 1].Date || '') : '');
      const buyLots = (h.buyLots && h.buyLots.length > 0) ? h.buyLots : [
        {
          transactionId: `${positionKey}-lot-1`,
          date: firstBuyDate,
          units: currentUnits,
          remainingUnits: currentUnits,
          unitCost: avgCost,
          costBasis: remainingCostBasis,
          ownershipTag: 'PERSONAL'
        }
      ];
      const txns = (h.txns && h.txns.length > 0) ? h.txns : [
        {
          id: `${positionKey}-txn-1`,
          date: firstBuyDate,
          action: 'BUY',
          units: currentUnits,
          unitPrice: avgCost,
          tradeValue: remainingCostBasis,
          investmentAccount: 'Share Market',
          subAccount: broker,
          security: h.symbol
        }
      ];

      shareMarketPositions.push({
        positionKey,
        investmentAccount: 'Share Market',
        subAccount: broker,
        isin: h.symbol,
        security: h.symbol,
        note: h.symbol,
        folioNumber: 'DEMAT',
        holdingMode: 'DEMAT',
        ownershipTag: 'PERSONAL',
        status: 'ACTIVE',
        currentUnits,
        buyUnits: currentUnits,
        sellUnits: 0,
        buyCost: remainingCostBasis,
        remainingCostBasis: Math.round(remainingCostBasis * 100) / 100,
        averageCostPerUnit: Math.round(avgCost * 10000) / 10000,
        sellCostBasis: 0,
        realizedPnl: 0,
        totalProceeds: 0,
        buyCount: txns.length || 1,
        sellCount: 0,
        firstBuyDate,
        lastTransactionDate,
        buyLots,
        sellRecords: [],
        txns,
        snapshotPrice: currentPrice,
        snapshotMarketValue: currentValue
      });
    });

    // Redeemed Share Market Holdings
    (data.redeemedHoldings || []).forEach(h => {
      if (!h || !h.symbol) return;

      const positionKey = `Share Market | ${broker} | ${h.symbol} | REDEEMED`;
      const buyCost = parseFloat(h.buyCost) || parseFloat(h.soldCostBasis) || 0;
      const soldCostBasis = parseFloat(h.soldCostBasis) || 0;
      const realizedPnl = parseFloat(h.realizedPnL) || 0;
      const totalProceeds = parseFloat(h.totalProceeds) || (soldCostBasis + realizedPnl);
      const exitedQty = parseFloat(h.exitedQty || h.sellQty || h.buyQty || 0);

      shareMarketPositions.push({
        positionKey,
        investmentAccount: 'Share Market',
        subAccount: broker,
        isin: h.symbol,
        security: h.symbol,
        note: h.symbol,
        folioNumber: 'DEMAT',
        holdingMode: 'DEMAT',
        ownershipTag: 'PERSONAL',
        status: 'REDEEMED',
        currentUnits: 0,
        buyUnits: exitedQty,
        sellUnits: exitedQty,
        buyCost: Math.round(buyCost * 100) / 100,
        remainingCostBasis: 0,
        averageCostPerUnit: exitedQty > 0 ? buyCost / exitedQty : 0,
        sellCostBasis: Math.round(soldCostBasis * 100) / 100,
        realizedPnl: Math.round(realizedPnl * 100) / 100,
        totalProceeds: Math.round(totalProceeds * 100) / 100,
        buyCount: (h.txns || []).length || 1,
        sellCount: (h.txns || []).filter(t => (t.InvestmentTransactionType || t.investment_transaction_type || '').toUpperCase() === 'SELL').length || 1,
        firstBuyDate: (h.txns && h.txns[0]) ? (h.txns[0].date || h.txns[0].Date || '') : '',
        lastTransactionDate: h.lastTransactionDate || '',
        buyLots: h.buyLots || [],
        sellRecords: [],
        txns: h.txns || []
      });
    });
  });

  // Deduplicate ETFs (Gold BeES & SilverBeES) that appear in both MF and Share Market
  const shareMarketIsins = new Set(
    shareMarketPositions.map(p => (p.isin || '').toUpperCase())
  );
  shareMarketIsins.add('INF204KB17I5');
  shareMarketIsins.add('INF204KC1402');

  const deduplicatedMfPositions = mfPositions.filter(p => {
    const isin = String(p.isin || '').toUpperCase();
    const security = String(p.security || p.note || '').toUpperCase();
    if (shareMarketIsins.has(isin) || security.includes('GOLD BEES') || security.includes('SILVERBEES')) {
      return false;
    }
    return true;
  });

  const allPositions = [...deduplicatedMfPositions, ...shareMarketPositions];
  const totalBrokerageCash = Object.values(brokerageCashMap).reduce((sum, v) => sum + v, 0);

  return {
    allPositions,
    mfPositions: deduplicatedMfPositions,
    shareMarketPositions,
    brokerageCashMap,
    totalBrokerageCash: Math.round(totalBrokerageCash * 100) / 100
  };
}
