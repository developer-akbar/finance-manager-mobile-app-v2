import React, { useState, useMemo } from 'react';
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
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('desc'); // 'asc' | 'desc'

  // Aggregate active and redeemed positions by Asset Class / Category
  const { rawRows, total1DAmount, total1DPercent } = useMemo(() => {
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
        oneDayAmount: 0,
        previousDayValuedCost: 0,
        hasOneDay: false,
        oneDayPercent: null,
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
          oneDayAmount: 0,
          previousDayValuedCost: 0,
          hasOneDay: false,
          oneDayPercent: null,
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

        if (typeof val.nav === 'number' && typeof val.previousClose === 'number' && val.previousClose > 0) {
          const units = p.currentUnits || 0;
          const dayDiff = val.nav - val.previousClose;
          cat.oneDayAmount += (dayDiff * units);
          cat.previousDayValuedCost += (val.previousClose * units);
          cat.hasOneDay = true;
        }
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
    let tot1D = 0;
    let totPrevCost = 0;
    let totHas1D = false;

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

      if (cat.hasOneDay && cat.previousDayValuedCost > 0) {
        cat.oneDayAmount = Math.round(cat.oneDayAmount * 100) / 100;
        cat.oneDayPercent = Math.round((cat.oneDayAmount / cat.previousDayValuedCost) * 10000) / 100;
        tot1D += cat.oneDayAmount;
        totPrevCost += cat.previousDayValuedCost;
        totHas1D = true;
      } else {
        cat.oneDayAmount = null;
        cat.oneDayPercent = null;
      }

      cat.activeCost = Math.round(cat.activeCost * 100) / 100;
      cat.currentValue = cat.hasPartialValuation ? Math.round(cat.currentValue * 100) / 100 : null;
      cat.realizedPnl = Math.round(cat.realizedPnl * 100) / 100;

      // Calculate category-level XIRR
      cat.xirr = computePortfolioXIRR(cat.activePositions, valuationProvider);

      rows.push(cat);
    }

    const tot1DPct = (totHas1D && totPrevCost > 0) 
      ? Math.round((tot1D / totPrevCost) * 10000) / 100 
      : null;

    return { 
      rawRows: rows, 
      total1DAmount: totHas1D ? Math.round(tot1D * 100) / 100 : null, 
      total1DPercent: tot1DPct 
    };
  }, [positions, valuationProvider, valuationVersion]);

  const breakdownData = useMemo(() => {
    if (!sortKey) return rawRows;

    return [...rawRows].sort((a, b) => {
      let comparison = 0;
      if (sortKey === 'category') {
        comparison = a.label.localeCompare(b.label);
      } else if (sortKey === 'holdings') {
        comparison = a.activeCount - b.activeCount;
      } else if (sortKey === 'cost') {
        comparison = a.activeCost - b.activeCost;
      } else if (sortKey === 'value') {
        comparison = (a.currentValue ?? -Infinity) - (b.currentValue ?? -Infinity);
      } else if (sortKey === 'oneDay') {
        comparison = (a.oneDayAmount ?? -Infinity) - (b.oneDayAmount ?? -Infinity);
      } else if (sortKey === 'unrealized') {
        comparison = (a.unrealizedPnl ?? -Infinity) - (b.unrealizedPnl ?? -Infinity);
      } else if (sortKey === 'realized') {
        comparison = a.realizedPnl - b.realizedPnl;
      } else if (sortKey === 'xirr') {
        comparison = (a.xirr ?? -Infinity) - (b.xirr ?? -Infinity);
      } else if (sortKey === 'coverage') {
        const covA = a.activeCount > 0 ? a.valuedCount / a.activeCount : 0;
        const covB = b.activeCount > 0 ? b.valuedCount / b.activeCount : 0;
        comparison = covA - covB;
      }
      return sortDir === 'asc' ? comparison : -comparison;
    });
  }, [rawRows, sortKey, sortDir]);

  const handleHeaderClick = (key) => {
    if (sortKey === key) {
      setSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'category' ? 'asc' : 'desc');
    }
  };

  const renderSortIndicator = (key) => {
    if (sortKey !== key) return null;
    return <span className="sort-indicator">{sortDir === 'asc' ? ' ↑' : ' ↓'}</span>;
  };

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

      {/* Desktop & Tablet Table Breakdown (>=768px) */}
      <div className="breakdown-table-container">
        <table className="breakdown-table">
          <thead>
            <tr>
              <th className="sortable-th" onClick={() => handleHeaderClick('category')}>
                Asset Category{renderSortIndicator('category')}
              </th>
              <th style={{ textAlign: 'center' }} className="sortable-th" onClick={() => handleHeaderClick('holdings')}>
                Holdings{renderSortIndicator('holdings')}
              </th>
              <th style={{ textAlign: 'right' }} className="sortable-th" onClick={() => handleHeaderClick('cost')}>
                Invested Cost{renderSortIndicator('cost')}
              </th>
              <th style={{ textAlign: 'right' }} className="sortable-th" onClick={() => handleHeaderClick('value')}>
                Current Value{renderSortIndicator('value')}
              </th>
              <th style={{ textAlign: 'right' }} className="sortable-th" onClick={() => handleHeaderClick('oneDay')}>
                1D Return{renderSortIndicator('oneDay')}
              </th>
              <th style={{ textAlign: 'right' }} className="sortable-th" onClick={() => handleHeaderClick('unrealized')}>
                Unrealized P&L{renderSortIndicator('unrealized')}
              </th>
              <th style={{ textAlign: 'right' }} className="sortable-th" onClick={() => handleHeaderClick('realized')}>
                Realized P&L{renderSortIndicator('realized')}
              </th>
              <th style={{ textAlign: 'right' }} className="sortable-th" onClick={() => handleHeaderClick('xirr')}>
                XIRR{renderSortIndicator('xirr')}
              </th>
              <th style={{ textAlign: 'center' }} className="sortable-th" onClick={() => handleHeaderClick('coverage')}>
                Valuation Coverage{renderSortIndicator('coverage')}
              </th>
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
                  {cat.oneDayAmount !== null ? (
                    <div className={getPnlClass(cat.oneDayAmount)}>
                      <span className="font-bold">
                        {cat.oneDayAmount > 0 ? '+' : ''}{formatINR(cat.oneDayAmount)}
                      </span>
                      {cat.oneDayPercent !== null && (
                        <div className="font-xs font-semibold">
                          ({formatSignedPercent(cat.oneDayPercent)})
                        </div>
                      )}
                    </div>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
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
                  {total1DAmount !== null ? (
                    <div className={getPnlClass(total1DAmount)}>
                      <span className="font-extrabold">
                        {total1DAmount > 0 ? '+' : ''}{formatINR(total1DAmount)}
                      </span>
                      {total1DPercent !== null && (
                        <div className="font-xs font-bold">
                          ({formatSignedPercent(total1DPercent)})
                        </div>
                      )}
                    </div>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
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

      {/* Mobile Card Breakdown (<768px) */}
      <div className="breakdown-cards-mobile">
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

            {/* Row 1: 3-Column Grid (INVESTED COST, CURRENT VALUE, 1D RETURN) */}
            <div className="breakdown-row-grid grid-3">
              <div className="breakdown-metric-col">
                <span className="breakdown-lbl text-muted uppercase">INVESTED COST</span>
                <span className="breakdown-val-primary font-bold text-primary num-tabular">{formatINR(cat.activeCost)}</span>
              </div>
              <div className="breakdown-metric-col text-center">
                <span className="breakdown-lbl text-muted uppercase">CURRENT VALUE</span>
                <span className="breakdown-val-primary font-bold text-primary num-tabular">
                  {cat.currentValue !== null ? formatINR(cat.currentValue) : <span className="text-muted font-normal text-sm">Not valued</span>}
                </span>
              </div>
              <div className="breakdown-metric-col text-right">
                <span className="breakdown-lbl text-muted uppercase">1D RETURN</span>
                {cat.oneDayAmount !== null ? (
                  <span className={`breakdown-val font-semibold num-tabular ${getPnlClass(cat.oneDayAmount)}`}>
                    {cat.oneDayAmount > 0 ? '+' : ''}{formatINR(cat.oneDayAmount)}
                    {cat.oneDayPercent !== null && (
                      <span className="breakdown-pct-tag"> ({formatSignedPercent(cat.oneDayPercent)})</span>
                    )}
                  </span>
                ) : (
                  <span className="breakdown-val text-muted num-tabular">—</span>
                )}
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
