import { useMemo } from 'react';
import { getUnifiedPortfolioData } from '../utils/portfolioSelector.js';
import { defaultValuationProvider } from '../utils/valuationProvider.js';

export function usePortfolio(transactions = [], settings = {}, filters = {}) {
  const {
    scopeFilter = 'personal', // 'personal' | 'all' | 'father'
    platformFilter = 'all',   // 'all' | subaccount name
    accountFilter = 'all',    // 'all' | account name
    valuationProvider = defaultValuationProvider
  } = filters;

  // 1. Unified raw positions & cash extraction
  const rawPortfolio = useMemo(() => {
    return getUnifiedPortfolioData(transactions, settings);
  }, [transactions, settings]);

  // 2. Filter by Ownership Scope
  const scopedPositions = useMemo(() => {
    const { allPositions } = rawPortfolio;
    if (scopeFilter === 'personal') {
      return allPositions.filter(p => p.ownershipTag === 'PERSONAL' || p.ownershipTag === 'MIXED_HOLDING');
    } else if (scopeFilter === 'father') {
      return allPositions.filter(p => p.ownershipTag === 'FATHER_EXTERNAL');
    }
    return allPositions;
  }, [rawPortfolio, scopeFilter]);

  // 3. Filter by Platform & Account
  const displayedPositions = useMemo(() => {
    return scopedPositions.filter(p => {
      if (platformFilter !== 'all' && p.subAccount !== platformFilter) return false;
      if (accountFilter !== 'all' && p.investmentAccount !== accountFilter) return false;
      return true;
    });
  }, [scopedPositions, platformFilter, accountFilter]);

  // Available filter dropdown options
  const availablePlatforms = useMemo(() => {
    const subs = new Set(scopedPositions.map(p => p.subAccount).filter(Boolean));
    return Array.from(subs);
  }, [scopedPositions]);

  const availableAccounts = useMemo(() => {
    const accts = new Set(scopedPositions.map(p => p.investmentAccount).filter(Boolean));
    return Array.from(accts);
  }, [scopedPositions]);

  // Active, Redeemed & Data Issue positions
  const activeHoldings = useMemo(() => {
    return displayedPositions.filter(p => p.status === 'ACTIVE');
  }, [displayedPositions]);

  const redeemedHoldings = useMemo(() => {
    return displayedPositions.filter(p => p.status === 'REDEEMED');
  }, [displayedPositions]);

  const dataIssues = useMemo(() => {
    return displayedPositions.filter(p => p.status === 'LEGACY_DATA_ISSUE');
  }, [displayedPositions]);

  // Segregated Brokerage Cash Calculation
  const relevantBrokerageCash = useMemo(() => {
    const { brokerageCashMap } = rawPortfolio;
    if (accountFilter !== 'all' && accountFilter !== 'Share Market') {
      return 0; // If filtered exclusively to Mutual Funds, brokerage cash is 0
    }
    if (platformFilter !== 'all') {
      return brokerageCashMap[platformFilter] || 0;
    }
    return rawPortfolio.totalBrokerageCash;
  }, [rawPortfolio, platformFilter, accountFilter]);

  // Summary Metrics
  const summaryMetrics = useMemo(() => {
    const activeCost = activeHoldings.reduce((sum, p) => sum + (p.remainingCostBasis || 0), 0);
    const activeUnits = activeHoldings.reduce((sum, p) => sum + (p.currentUnits || 0), 0);
    const realizedPnl = displayedPositions.reduce((sum, p) => sum + (p.realizedPnl || 0), 0);

    let valuedCurrentValue = 0;
    let valuedCostBasis = 0;
    let valuedCount = 0;

    for (const p of activeHoldings) {
      const v = valuationProvider.getValuation(p);
      if (v && v.isValued) {
        valuedCurrentValue += (v.currentValue || 0);
        valuedCostBasis += (p.remainingCostBasis || 0);
        valuedCount++;
      }
    }

    const totalActiveCount = activeHoldings.length;
    const isFullyValued = totalActiveCount > 0 && valuedCount === totalActiveCount;
    const hasPartialValuation = valuedCount > 0;

    const totalValuedAmount = hasPartialValuation ? Math.round(valuedCurrentValue * 100) / 100 : null;
    const valuedUnrealizedPnl = hasPartialValuation ? Math.round((valuedCurrentValue - valuedCostBasis) * 100) / 100 : null;

    // Only compute portfolio-level unrealized P&L as a single number if 100% of holdings are valued
    const totalUnrealizedPnl = isFullyValued ? valuedUnrealizedPnl : null;
    const unrealizedReturnPercent = (isFullyValued && valuedCostBasis > 0)
      ? Math.round((totalUnrealizedPnl / valuedCostBasis) * 10000) / 100
      : null;

    const valuedReturnPercent = (hasPartialValuation && valuedCostBasis > 0)
      ? Math.round((valuedUnrealizedPnl / valuedCostBasis) * 10000) / 100
      : null;

    const valuationCoverageCountPercent = totalActiveCount > 0
      ? Math.round((valuedCount / totalActiveCount) * 100)
      : 0;

    const uniquePlatforms = new Set(displayedPositions.map(p => p.subAccount).filter(Boolean));

    return {
      activeCostBasis: Math.round(activeCost * 100) / 100,
      activeUnits: Math.round(activeUnits * 1000) / 1000,
      totalRealizedPnl: Math.round(realizedPnl * 100) / 100,
      totalValuedAmount,
      valuedCostBasis: Math.round(valuedCostBasis * 100) / 100,
      valuedUnrealizedPnl,
      valuedReturnPercent,
      totalUnrealizedPnl,
      unrealizedReturnPercent,
      isFullyValued,
      hasPartialValuation,
      valuedCount,
      totalActiveCount,
      valuationCoverageCountPercent,
      brokerageCash: relevantBrokerageCash,
      totalFinancialAssets: Math.round(((hasPartialValuation ? valuedCurrentValue + (activeCost - valuedCostBasis) : activeCost) + relevantBrokerageCash) * 100) / 100,
      activeHoldingsCount: activeHoldings.length,
      redeemedCount: redeemedHoldings.length,
      dataIssuesCount: dataIssues.length,
      platformCount: uniquePlatforms.size
    };
  }, [activeHoldings, redeemedHoldings, dataIssues, displayedPositions, relevantBrokerageCash, valuationProvider]);

  // Trade Statistics
  const tradeStats = useMemo(() => {
    let buyCount = 0;
    let sellCount = 0;
    let winningCount = 0;
    let losingCount = 0;
    let bestPerformer = null;
    let worstPerformer = null;

    for (const p of displayedPositions) {
      buyCount += (p.buyCount || 0);
      sellCount += (p.sellCount || 0);

      if (p.status === 'REDEEMED') {
        if (p.realizedPnl > 0) winningCount++;
        else if (p.realizedPnl < 0) losingCount++;
      }

      const pnl = p.status === 'REDEEMED' ? p.realizedPnl : (valuationProvider.getValuation(p).unrealizedPnl || 0);
      if (!bestPerformer || pnl > (bestPerformer.pnl || 0)) {
        bestPerformer = { name: p.note || p.security, pnl, status: p.status, platform: p.subAccount };
      }
      if (!worstPerformer || pnl < (worstPerformer.pnl || 0)) {
        worstPerformer = { name: p.note || p.security, pnl, status: p.status, platform: p.subAccount };
      }
    }

    return {
      activeCount: activeHoldings.length,
      redeemedCount: redeemedHoldings.length,
      buyCount,
      sellCount,
      winningCount,
      losingCount,
      bestPerformer,
      worstPerformer
    };
  }, [displayedPositions, activeHoldings, redeemedHoldings, valuationProvider]);

  return {
    allPositions: rawPortfolio.allPositions,
    scopedPositions,
    displayedPositions,
    activeHoldings,
    redeemedHoldings,
    dataIssues,
    availablePlatforms,
    availableAccounts,
    summaryMetrics,
    tradeStats,
    brokerageCashMap: rawPortfolio.brokerageCashMap,
    totalBrokerageCash: rawPortfolio.totalBrokerageCash
  };
}
