import React, { useMemo } from 'react';
import { formatINR } from '../../../utils/format.js';
import { 
  formatSignedCurrency, 
  formatSignedPercent, 
  getPnlClass, 
  getInvestmentDisplayMetrics,
  computePortfolioXIRR 
} from '../../../utils/portfolioAggregation.js';

export default function PortfolioBreakdown({ 
  positions = [], 
  valuationProvider, 
  valuationVersion, 
  summaryMetrics 
}) {
  // Aggregate active and redeemed positions by Asset Class / Category
  const breakdownData = useMemo(() => {
    const activePositions = positions.filter(p => p.status === 'ACTIVE');
    const redeemedPositions = positions.filter(p => p.status === 'REDEEMED');

    // Grouping map by Category: MUTUAL_FUND | EQUITY | ETF
    const categories = [
      { key: 'MUTUAL_FUND', label: 'Mutual Funds', tag: 'MF' },
      { key: 'EQUITY', label: 'Equity Shares', tag: 'EQ' },
      { key: 'ETF', label: 'Exchange Traded Funds', tag: 'ETF' }
    ];

    const categoryMap = {};
    for (const cat of categories) {
      categoryMap[cat.key] = {
        key: cat.key,
        label: cat.label,
        tag: cat.tag,
        activePositions: [],
        redeemedPositions: [],
        activeCount: 0,
        activeCost: 0,
        currentValue: 0,
        valuedCost: 0,
        valuedCount: 0,
        realizedPnl: 0,
        unrealizedPnl: 0,
        returnPercent: null,
        isFullyValued: false,
        hasPartialValuation: false,
        xirr: null
      };
    }

    // Process active positions
    for (const p of activePositions) {
      const meta = getInvestmentDisplayMetrics(p);
      const catKey = meta.assetType || 'MUTUAL_FUND';
      if (!categoryMap[catKey]) {
        categoryMap[catKey] = {
          key: catKey,
          label: catKey,
          tag: catKey,
          activePositions: [],
          redeemedPositions: [],
          activeCount: 0,
          activeCost: 0,
          currentValue: 0,
          valuedCost: 0,
          valuedCount: 0,
          realizedPnl: 0,
          unrealizedPnl: 0,
          returnPercent: null,
          isFullyValued: false,
          hasPartialValuation: false,
          xirr: null
        };
      }

      const cat = categoryMap[catKey];
      cat.activePositions.push(p);
      cat.activeCount++;
      cat.activeCost += (p.remainingCostBasis || 0);
      cat.realizedPnl += (p.realizedPnl || 0);

      const val = valuationProvider ? valuationProvider.getValuation(p) : p.valuation;
      if (val && val.isValued && typeof val.currentValue === 'number') {
        cat.currentValue += val.currentValue;
        cat.valuedCost += (p.remainingCostBasis || 0);
        cat.valuedCount++;
      }
    }

    // Process redeemed positions for realized P&L
    for (const p of redeemedPositions) {
      const meta = getInvestmentDisplayMetrics(p);
      const catKey = meta.assetType || 'MUTUAL_FUND';
      if (categoryMap[catKey]) {
        categoryMap[catKey].redeemedPositions.push(p);
        categoryMap[catKey].realizedPnl += (p.realizedPnl || 0);
      }
    }

    // Compute metrics and XIRR for each category with active or redeemed positions
    const rows = [];
    for (const catKey of Object.keys(categoryMap)) {
      const cat = categoryMap[catKey];
      if (cat.activeCount === 0 && cat.redeemedPositions.length === 0) {
        continue;
      }

      cat.isFullyValued = cat.activeCount > 0 && cat.valuedCount === cat.activeCount;
      cat.hasPartialValuation = cat.valuedCount > 0;

      if (cat.hasPartialValuation) {
        cat.unrealizedPnl = Math.round((cat.currentValue - cat.valuedCost) * 100) / 100;
        cat.returnPercent = cat.valuedCost > 0 
          ? Math.round((cat.unrealizedPnl / cat.valuedCost) * 10000) / 100 
          : null;
      } else {
        cat.unrealizedPnl = null;
        cat.returnPercent = null;
      }

      cat.activeCost = Math.round(cat.activeCost * 100) / 100;
      cat.currentValue = cat.hasPartialValuation ? Math.round(cat.currentValue * 100) / 100 : null;
      cat.realizedPnl = Math.round(cat.realizedPnl * 100) / 100;

      // Calculate category-level XIRR
      cat.xirr = computePortfolioXIRR(cat.activePositions, valuationProvider);

      rows.push(cat);
    }

    return rows;
  }, [positions, valuationProvider, valuationVersion]);

  if (positions.length === 0) {
    return null;
  }

  return (
    <div className="portfolio-card portfolio-breakdown-card">
      <div className="portfolio-card-header flex-between">
        <div>
          <h4 className="portfolio-card-title">Portfolio Breakdown</h4>
          <div className="portfolio-card-sub">
            Performance & valuation coverage by asset category
          </div>
        </div>
      </div>

      {/* Desktop Table Breakdown */}
      <div className="breakdown-table-container desktop-only">
        <table className="breakdown-table">
          <thead>
            <tr>
              <th>Asset Category</th>
              <th style={{ textAlign: 'center' }}>Holdings</th>
              <th style={{ textAlign: 'right' }}>Invested Cost</th>
              <th style={{ textAlign: 'right' }}>Current Value</th>
              <th style={{ textAlign: 'right' }}>Unrealized P&L</th>
              <th style={{ textAlign: 'right' }}>Realized P&L</th>
              <th style={{ textAlign: 'right' }}>XIRR</th>
              <th style={{ textAlign: 'center' }}>Valuation Coverage</th>
            </tr>
          </thead>
          <tbody>
            {breakdownData.map(cat => (
              <tr key={cat.key} className="breakdown-row">
                <td className="category-cell">
                  <div className="font-bold category-name">{cat.label}</div>
                  <div className="text-muted font-xs">{cat.activeCount} active · {cat.redeemedPositions.length} redeemed</div>
                </td>
                <td style={{ textAlign: 'center' }} className="num-tabular font-semibold">
                  {cat.activeCount}
                </td>
                <td style={{ textAlign: 'right' }} className="num-tabular font-semibold">
                  {formatINR(cat.activeCost)}
                </td>
                <td style={{ textAlign: 'right' }} className="num-tabular font-bold current-val-cell">
                  {cat.currentValue !== null ? formatINR(cat.currentValue) : <span className="text-muted">Not valued</span>}
                </td>
                <td style={{ textAlign: 'right' }} className="num-tabular">
                  {cat.unrealizedPnl !== null ? (
                    <div className={getPnlClass(cat.unrealizedPnl)}>
                      <span className="font-bold">{formatSignedCurrency(cat.unrealizedPnl)}</span>
                      {cat.returnPercent !== null && (
                        <div className="font-xs font-semibold">({formatSignedPercent(cat.returnPercent)})</div>
                      )}
                    </div>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td style={{ textAlign: 'right' }} className="num-tabular">
                  <span className={`font-semibold ${getPnlClass(cat.realizedPnl)}`}>
                    {cat.realizedPnl !== 0 ? formatSignedCurrency(cat.realizedPnl) : '₹0'}
                  </span>
                </td>
                <td style={{ textAlign: 'right' }} className="num-tabular">
                  {cat.xirr !== null ? (
                    <span className={`font-bold ${getPnlClass(cat.xirr)}`}>
                      {formatSignedPercent(cat.xirr)}
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td style={{ textAlign: 'center' }}>
                  {cat.activeCount === 0 ? (
                    <span className="coverage-badge gray">0 Active</span>
                  ) : cat.isFullyValued ? (
                    <span className="coverage-badge green">100% ({cat.valuedCount}/{cat.activeCount})</span>
                  ) : cat.hasPartialValuation ? (
                    <span className="coverage-badge orange">{cat.valuedCount}/{cat.activeCount} Valued</span>
                  ) : (
                    <span className="coverage-badge gray">Not valued</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          {summaryMetrics && (
            <tfoot>
              <tr className="breakdown-total-row">
                <td>
                  <span className="font-extrabold uppercase">Total Portfolio</span>
                </td>
                <td style={{ textAlign: 'center' }} className="num-tabular font-extrabold">
                  {summaryMetrics.activeHoldingsCount || 0}
                </td>
                <td style={{ textAlign: 'right' }} className="num-tabular font-extrabold">
                  {formatINR(summaryMetrics.activeCostBasis || 0)}
                </td>
                <td style={{ textAlign: 'right' }} className="num-tabular font-extrabold current-val-cell">
                  {summaryMetrics.totalValuedAmount !== null ? formatINR(summaryMetrics.totalValuedAmount) : <span className="text-muted">Not valued</span>}
                </td>
                <td style={{ textAlign: 'right' }} className="num-tabular">
                  {summaryMetrics.valuedUnrealizedPnl !== null ? (
                    <div className={getPnlClass(summaryMetrics.valuedUnrealizedPnl)}>
                      <span className="font-extrabold">{formatSignedCurrency(summaryMetrics.valuedUnrealizedPnl)}</span>
                      {summaryMetrics.valuedReturnPercent !== null && (
                        <div className="font-xs font-bold">({formatSignedPercent(summaryMetrics.valuedReturnPercent)})</div>
                      )}
                    </div>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td style={{ textAlign: 'right' }} className="num-tabular">
                  <span className={`font-extrabold ${getPnlClass(summaryMetrics.totalRealizedPnl)}`}>
                    {formatSignedCurrency(summaryMetrics.totalRealizedPnl || 0)}
                  </span>
                </td>
                <td style={{ textAlign: 'right' }} className="num-tabular">
                  {summaryMetrics.portfolioXirr !== null ? (
                    <span className={`font-extrabold ${getPnlClass(summaryMetrics.portfolioXirr)}`}>
                      {formatSignedPercent(summaryMetrics.portfolioXirr)}
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td style={{ textAlign: 'center' }}>
                  {summaryMetrics.isFullyValued ? (
                    <span className="coverage-badge green">100% ({summaryMetrics.valuedCount}/{summaryMetrics.totalActiveCount})</span>
                  ) : summaryMetrics.hasPartialValuation ? (
                    <span className="coverage-badge orange">{summaryMetrics.valuedCount}/{summaryMetrics.totalActiveCount} Valued</span>
                  ) : (
                    <span className="coverage-badge gray">Not valued</span>
                  )}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Mobile Card Breakdown */}
      <div className="breakdown-cards-mobile mobile-only">
        {breakdownData.map(cat => (
          <div key={cat.key} className="breakdown-mobile-card">
            {/* Header: Category Name + Active Count + Clean Single-line Badge */}
            <div className="breakdown-card-head flex-between align-center">
              <div className="breakdown-title-box flex-gap-xs align-baseline">
                <span className="breakdown-category-title font-bold text-primary">{cat.label}</span>
                <span className="breakdown-active-count text-muted font-xs">({cat.activeCount} active)</span>
              </div>
              <div className="breakdown-badge-box">
                {cat.activeCount === 0 ? (
                  <span className="coverage-badge gray">0 Active</span>
                ) : cat.isFullyValued ? (
                  <span className="coverage-badge green">100% Valued</span>
                ) : cat.hasPartialValuation ? (
                  <span className="coverage-badge orange">{cat.valuedCount}/{cat.activeCount} Valued</span>
                ) : (
                  <span className="coverage-badge gray">Not valued</span>
                )}
              </div>
            </div>

            {/* Row 1: 2-Column Grid (INVESTED COST & CURRENT VALUE) */}
            <div className="breakdown-row-grid grid-2">
              <div className="breakdown-metric-col">
                <span className="breakdown-lbl text-muted uppercase">INVESTED COST</span>
                <span className="breakdown-val-primary font-bold text-primary num-tabular">{formatINR(cat.activeCost)}</span>
              </div>
              <div className="breakdown-metric-col text-right">
                <span className="breakdown-lbl text-muted uppercase">CURRENT VALUE</span>
                <span className="breakdown-val-primary font-bold text-primary num-tabular">
                  {cat.currentValue !== null ? formatINR(cat.currentValue) : <span className="text-muted font-normal text-sm">Not valued</span>}
                </span>
              </div>
            </div>

            {/* Row 2: 3-Column Grid (UNREALIZED P&L, REALIZED P&L, XIRR) */}
            <div className="breakdown-row-grid grid-3 breakdown-sub-row">
              <div className="breakdown-metric-col">
                <span className="breakdown-lbl text-muted uppercase">UNREALIZED P&L</span>
                {cat.unrealizedPnl !== null ? (
                  <span className={`breakdown-val font-semibold num-tabular ${getPnlClass(cat.unrealizedPnl)}`}>
                    {formatSignedCurrency(cat.unrealizedPnl)}
                    {cat.returnPercent !== null && (
                      <span className="breakdown-pct-tag"> ({formatSignedPercent(cat.returnPercent)})</span>
                    )}
                  </span>
                ) : (
                  <span className="breakdown-val text-muted num-tabular">—</span>
                )}
              </div>
              <div className="breakdown-metric-col text-center">
                <span className="breakdown-lbl text-muted uppercase">REALIZED P&L</span>
                <span className={`breakdown-val font-semibold num-tabular ${cat.realizedPnl !== 0 ? getPnlClass(cat.realizedPnl) : 'text-muted'}`}>
                  {cat.realizedPnl !== 0 ? formatSignedCurrency(cat.realizedPnl) : '₹0'}
                </span>
              </div>
              <div className="breakdown-metric-col text-right">
                <span className="breakdown-lbl text-muted uppercase">XIRR</span>
                {cat.xirr !== null ? (
                  <span className={`breakdown-val font-semibold num-tabular ${getPnlClass(cat.xirr)}`}>
                    {formatSignedPercent(cat.xirr)}
                  </span>
                ) : (
                  <span className="breakdown-val text-muted num-tabular">—</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
