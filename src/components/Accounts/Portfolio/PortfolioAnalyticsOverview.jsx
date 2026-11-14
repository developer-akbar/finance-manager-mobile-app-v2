import React, { useState, useMemo } from 'react';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from 'recharts';
import { formatINR } from '../../../utils/format.js';
import { 
  getInvestmentDisplayMetrics,
  formatSignedCurrency, 
  formatSignedPercent, 
  getPnlClass,
  computePortfolioXIRR 
} from '../../../utils/portfolioAggregation.js';

const ANALYTICS_PALETTE = [
  '#0075FF', '#00D2D3', '#01B574', '#FFAA00', '#EC4899', 
  '#8B5CF6', '#0284C7', '#10B981', '#F97316', '#64748B', '#A855F7'
];

export default function PortfolioAnalyticsOverview({
  positions = [],
  valuationProvider,
  valuationVersion,
  summaryMetrics,
  onSelectPosition
}) {
  const [allocationBasis, setAllocationBasis] = useState('value'); // 'value' | 'cost'
  const [allocationDimension, setAllocationDimension] = useState('category'); // 'category' | 'platform' | 'account'

  const activePositions = useMemo(() => {
    return positions.filter(p => p.status === 'ACTIVE' && ((p.remainingCostBasis || 0) > 0 || (p.currentUnits || 0) > 0));
  }, [positions]);

  // 1. Portfolio Valuation Coverage & Totals
  const coverageData = useMemo(() => {
    let valuedCount = 0;
    const totalCount = activePositions.length;
    let totalValuedCurrent = 0;
    let valuedCost = 0;
    let unvaluedCost = 0;

    for (const p of activePositions) {
      const val = valuationProvider ? valuationProvider.getValuation(p) : p.valuation;
      if (val && val.isValued && typeof val.currentValue === 'number' && val.currentValue > 0) {
        valuedCount++;
        totalValuedCurrent += val.currentValue;
        valuedCost += (p.remainingCostBasis || 0);
      } else {
        unvaluedCost += (p.remainingCostBasis || 0);
      }
    }

    const coveragePct = totalCount > 0 ? Math.round((valuedCount / totalCount) * 100) : 0;
    const totalInvested = valuedCost + unvaluedCost;

    return {
      valuedCount,
      totalCount,
      unvaluedCount: totalCount - valuedCount,
      coveragePct,
      totalValuedCurrent: Math.round(totalValuedCurrent * 100) / 100,
      valuedCost: Math.round(valuedCost * 100) / 100,
      unvaluedCost: Math.round(unvaluedCost * 100) / 100,
      totalInvested: Math.round(totalInvested * 100) / 100,
      isFullyValued: totalCount > 0 && valuedCount === totalCount,
      hasPartialValuation: valuedCount > 0
    };
  }, [activePositions, valuationProvider, valuationVersion]);

  // 2. Asset Category Performance Breakdown
  const categoryPerformance = useMemo(() => {
    const cats = [
      { key: 'MUTUAL_FUND', label: 'Mutual Funds', tag: 'MF', color: '#0075FF' },
      { key: 'EQUITY', label: 'Equity Shares', tag: 'EQ', color: '#00D2D3' },
      { key: 'ETF', label: 'Exchange Traded Funds', tag: 'ETF', color: '#01B574' }
    ];

    const map = {};
    for (const c of cats) {
      map[c.key] = {
        ...c,
        activePositions: [],
        activeCount: 0,
        investedCost: 0,
        currentValue: 0,
        valuedCost: 0,
        valuedCount: 0,
        unrealizedPnl: 0,
        returnPercent: null,
        xirr: null
      };
    }

    for (const p of activePositions) {
      const meta = getInvestmentDisplayMetrics(p);
      const k = meta.assetType || 'MUTUAL_FUND';
      if (!map[k]) {
        map[k] = {
          key: k,
          label: k,
          tag: k,
          color: '#8B5CF6',
          activePositions: [],
          activeCount: 0,
          investedCost: 0,
          currentValue: 0,
          valuedCost: 0,
          valuedCount: 0,
          unrealizedPnl: 0,
          returnPercent: null,
          xirr: null
        };
      }

      const item = map[k];
      item.activePositions.push(p);
      item.activeCount++;
      item.investedCost += (p.remainingCostBasis || 0);

      const val = valuationProvider ? valuationProvider.getValuation(p) : p.valuation;
      if (val && val.isValued && typeof val.currentValue === 'number' && val.currentValue > 0) {
        item.currentValue += val.currentValue;
        item.valuedCost += (p.remainingCostBasis || 0);
        item.valuedCount++;
      }
    }

    return Object.values(map)
      .filter(c => c.activeCount > 0)
      .map(c => {
        const hasVal = c.valuedCount > 0;
        const pnl = hasVal ? (c.currentValue - c.valuedCost) : 0;
        const retPct = (hasVal && c.valuedCost > 0) ? (pnl / c.valuedCost) * 100 : null;
        const xirr = computePortfolioXIRR(c.activePositions, valuationProvider);

        return {
          ...c,
          investedCost: Math.round(c.investedCost),
          currentValue: hasVal ? Math.round(c.currentValue) : null,
          unrealizedPnl: hasVal ? Math.round(pnl) : null,
          returnPercent: retPct !== null ? Math.round(retPct * 100) / 100 : null,
          xirr: xirr !== null ? Math.round(xirr * 100) / 100 : null,
          isFullyValued: c.valuedCount === c.activeCount
        };
      })
      .sort((a, b) => (b.currentValue || b.investedCost) - (a.currentValue || a.investedCost));
  }, [activePositions, valuationProvider, valuationVersion]);

  // Max value for horizontal comparison bars scaling
  const maxCategoryMetric = useMemo(() => {
    let max = 1;
    for (const c of categoryPerformance) {
      if (c.investedCost > max) max = c.investedCost;
      if (c.currentValue && c.currentValue > max) max = c.currentValue;
    }
    return max;
  }, [categoryPerformance]);

  // 3. Top Holdings Concentration
  const topHoldings = useMemo(() => {
    const list = activePositions.map(p => {
      const val = valuationProvider ? valuationProvider.getValuation(p) : p.valuation;
      const isValued = val && val.isValued && typeof val.currentValue === 'number' && val.currentValue > 0;
      const currentVal = isValued ? val.currentValue : (p.remainingCostBasis || 0);
      const cost = p.remainingCostBasis || 0;
      const pnl = isValued ? (currentVal - cost) : null;
      const pnlPct = (isValued && cost > 0) ? (pnl / cost) * 100 : null;

      return {
        id: p.positionKey || p.id,
        name: p.note || p.security || p.isin || 'Unknown Security',
        isin: p.isin,
        subAccount: p.subAccount,
        currentVal: Math.round(currentVal),
        cost: Math.round(cost),
        isValued,
        pnl: pnl !== null ? Math.round(pnl) : null,
        pnlPct: pnlPct !== null ? Math.round(pnlPct * 10) / 10 : null,
        rawPosition: p
      };
    });

    list.sort((a, b) => b.currentVal - a.currentVal);

    const totalVal = list.reduce((sum, item) => sum + item.currentVal, 0);
    const top5 = list.slice(0, 5).map(item => ({
      ...item,
      sharePct: totalVal > 0 ? Math.round((item.currentVal / totalVal) * 1000) / 10 : 0
    }));

    const top5TotalShare = top5.reduce((sum, item) => sum + item.sharePct, 0);

    return {
      items: top5,
      totalVal,
      top5TotalShare: Math.round(top5TotalShare * 10) / 10,
      hasConcentrationRisk: top5.some(item => item.sharePct >= 25)
    };
  }, [activePositions, valuationProvider, valuationVersion]);

  // 4. Donut Allocation Data by Dimension (Category, Platform, Account)
  const donutData = useMemo(() => {
    const map = {};
    const effectiveBasis = (allocationBasis === 'value' && !coverageData.hasPartialValuation) ? 'cost' : allocationBasis;

    for (const p of activePositions) {
      let key = '';
      if (allocationDimension === 'category') {
        const meta = getInvestmentDisplayMetrics(p);
        key = meta.assetType === 'MUTUAL_FUND' 
          ? 'Mutual Funds' 
          : meta.assetType === 'ETF' 
            ? 'Exchange Traded Funds' 
            : 'Equity Shares';
      } else if (allocationDimension === 'platform') {
        key = p.subAccount || 'Default Platform';
      } else {
        key = p.investmentAccount || 'Liquid Mutual Funds';
      }

      let amount = 0;
      if (effectiveBasis === 'value') {
        const val = valuationProvider ? valuationProvider.getValuation(p) : p.valuation;
        if (val && val.isValued && typeof val.currentValue === 'number' && val.currentValue > 0) {
          amount = val.currentValue;
        } else {
          amount = p.remainingCostBasis || 0;
        }
      } else {
        amount = p.remainingCostBasis || 0;
      }

      if (!map[key]) {
        map[key] = { name: key, value: 0, count: 0 };
      }
      map[key].value += amount;
      map[key].count += 1;
    }

    const total = Object.values(map).reduce((sum, item) => sum + item.value, 0);
    if (total === 0) return [];

    const sorted = Object.values(map)
      .map(item => ({
        name: item.name,
        value: Math.round(item.value),
        count: item.count,
        percent: ((item.value / total) * 100).toFixed(1)
      }))
      .sort((a, b) => b.value - a.value);

    return sorted;
  }, [activePositions, allocationDimension, allocationBasis, coverageData.hasPartialValuation, valuationProvider, valuationVersion]);

  const totalDonutAmount = useMemo(() => {
    return donutData.reduce((sum, item) => sum + item.value, 0);
  }, [donutData]);

  if (activePositions.length === 0) {
    return null;
  }

  return (
    <div className="portfolio-analytics-overview">
      {/* ── 1. PORTFOLIO VALUATION COVERAGE BANNER ────────────────────── */}
      <div className="portfolio-card coverage-summary-card mb-3">
        <div className="coverage-summary-header flex-between align-center">
          <div className="coverage-title-wrap">
            <span className="coverage-card-eyebrow">VALUATION AUDIT & FRESHNESS</span>
            <h4 className="portfolio-card-title mt-0.5">Portfolio Valuation Coverage</h4>
          </div>
          <div className="coverage-badge-wrap">
            <span className={`coverage-badge ${coverageData.isFullyValued ? 'green' : coverageData.hasPartialValuation ? 'orange' : 'gray'}`}>
              <span className={`coverage-dot ${coverageData.isFullyValued ? 'green' : coverageData.hasPartialValuation ? 'orange' : 'gray'}`} />
              {coverageData.valuedCount} / {coverageData.totalCount} Positions Valued ({coverageData.coveragePct}%)
            </span>
          </div>
        </div>

        {/* Visual Progress Bar of Valuation */}
        <div className="coverage-progress-track mt-2">
          <div 
            className="coverage-progress-bar valued" 
            style={{ width: `${Math.min(100, Math.max(0, coverageData.coveragePct))}%` }} 
          />
        </div>

        <div className="coverage-meta-grid grid-3 mt-2 font-xs">
          <div className="coverage-meta-col">
            <span className="text-muted block">Live Valued Portfolio</span>
            <strong className="num-tabular text-primary font-semibold">
              {coverageData.hasPartialValuation ? formatINR(coverageData.totalValuedCurrent) : 'Awaiting Prices'}
            </strong>
          </div>
          <div className="coverage-meta-col">
            <span className="text-muted block">Valued Cost Basis</span>
            <strong className="num-tabular text-primary font-semibold">
              {formatINR(coverageData.valuedCost)}
            </strong>
          </div>
          <div className="coverage-meta-col">
            <span className="text-muted block">Unvalued Capital at Cost</span>
            <strong className="num-tabular text-muted font-semibold">
              {formatINR(coverageData.unvaluedCost)}
            </strong>
          </div>
        </div>

        {!coverageData.isFullyValued && (
          <div className="coverage-explainer-note mt-2 text-xs text-muted">
            ℹ️ Unvalued positions are strictly preserved at deployed cost basis. They are never discarded or coerced to ₹0.
          </div>
        )}
      </div>

      {/* ── 2. TWO-COLUMN ANALYTICS GRID: ALLOCATION DONUT + CATEGORY COMPARISON ── */}
      <div className="portfolio-analytics-grid mb-3">
        {/* Card A: Asset & Dimension Allocation Donut */}
        <div className="portfolio-card analytics-donut-card">
          <div className="portfolio-card-header flex-between flex-wrap gap-2">
            <div>
              <span className="coverage-card-eyebrow">CAPITAL DISTRIBUTION</span>
              <h4 className="portfolio-card-title mt-0.5">Asset Allocation</h4>
            </div>

            <div className="allocation-control-pills flex-gap-xs">
              <div className="portfolio-pill-selector basis-selector">
                <button 
                  type="button"
                  className={`portfolio-pill ${allocationBasis === 'value' ? 'active' : ''}`}
                  onClick={() => setAllocationBasis('value')}
                  title="View by current market value"
                >
                  Value
                </button>
                <button 
                  type="button"
                  className={`portfolio-pill ${allocationBasis === 'cost' ? 'active' : ''}`}
                  onClick={() => setAllocationBasis('cost')}
                  title="View by invested cost"
                >
                  Cost
                </button>
              </div>

              <div className="portfolio-pill-selector">
                <button 
                  type="button"
                  className={`portfolio-pill ${allocationDimension === 'category' ? 'active' : ''}`}
                  onClick={() => setAllocationDimension('category')}
                >
                  Asset
                </button>
                <button 
                  type="button"
                  className={`portfolio-pill ${allocationDimension === 'platform' ? 'active' : ''}`}
                  onClick={() => setAllocationDimension('platform')}
                >
                  Platform
                </button>
                <button 
                  type="button"
                  className={`portfolio-pill ${allocationDimension === 'account' ? 'active' : ''}`}
                  onClick={() => setAllocationDimension('account')}
                >
                  Account
                </button>
              </div>
            </div>
          </div>

          <div className="allocation-chart-content mt-2">
            <div className="allocation-pie-wrap" style={{ width: 200, height: 200, minWidth: 200, minHeight: 200 }}>
              <ResponsiveContainer width={200} height={200} minWidth={200} minHeight={200}>
                <PieChart>
                  <Pie
                    data={donutData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={58}
                    outerRadius={86}
                    paddingAngle={2}
                  >
                    {donutData.map((entry, index) => (
                      <Cell key={`donut-${index}`} fill={ANALYTICS_PALETTE[index % ANALYTICS_PALETTE.length]} />
                    ))}
                  </Pie>
                  <Tooltip 
                    formatter={(val) => [formatINR(val), allocationBasis === 'value' ? 'Current Value' : 'Invested Cost']}
                    contentStyle={{ 
                      background: 'var(--bg-card)', 
                      borderColor: 'var(--border)', 
                      borderRadius: 8, 
                      fontSize: '0.78rem',
                      color: 'var(--text-primary)' 
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="allocation-pie-center-text">
                <span className="allocation-center-lbl">
                  {allocationBasis === 'value' ? 'Value' : 'Cost'}
                </span>
                <span className="allocation-center-val num-tabular">{formatINR(totalDonutAmount)}</span>
              </div>
            </div>

            <div className="allocation-legend-list">
              {donutData.map((item, index) => (
                <div key={item.name} className="allocation-legend-item">
                  <span 
                    className="allocation-legend-dot" 
                    style={{ backgroundColor: ANALYTICS_PALETTE[index % ANALYTICS_PALETTE.length] }} 
                  />
                  <span className="allocation-legend-name" title={item.name}>
                    {item.name}
                  </span>
                  <span className="allocation-legend-pct num-tabular">{item.percent}%</span>
                  <span className="allocation-legend-val num-tabular">{formatINR(item.value)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Card B: Asset Category Performance (Horizontal Comparative Bars) */}
        <div className="portfolio-card analytics-category-perf-card">
          <div className="portfolio-card-header flex-between">
            <div>
              <span className="coverage-card-eyebrow">COMPARATIVE RETURNS</span>
              <h4 className="portfolio-card-title mt-0.5">Asset Category Performance</h4>
            </div>
            <span className="text-muted font-xs">Invested vs Current</span>
          </div>

          <div className="category-perf-bars-list mt-2.5">
            {categoryPerformance.map(cat => {
              const costWidth = Math.max(4, Math.round((cat.investedCost / maxCategoryMetric) * 100));
              const valWidth = cat.currentValue ? Math.max(4, Math.round((cat.currentValue / maxCategoryMetric) * 100)) : 0;
              const hasVal = cat.currentValue !== null;

              return (
                <div key={cat.key} className="cat-perf-row mb-3">
                  <div className="cat-perf-meta flex-between align-center mb-1">
                    <div className="flex-gap-xs align-center">
                      <span className={`asset-cat-tag ${cat.tag.toLowerCase()}`}>{cat.tag}</span>
                      <strong className="cat-name font-sm">{cat.label}</strong>
                      <span className="text-muted font-xs">({cat.activeCount} holding{cat.activeCount !== 1 ? 's' : ''})</span>
                    </div>
                    <div className="cat-perf-returns flex-gap-xs align-center num-tabular">
                      {hasVal && cat.unrealizedPnl !== null && (
                        <span className={`font-semibold font-xs ${getPnlClass(cat.unrealizedPnl)}`}>
                          {formatSignedCurrency(cat.unrealizedPnl)}
                        </span>
                      )}
                      {cat.returnPercent !== null && (
                        <span className={`portfolio-kpi-pill ${getPnlClass(cat.returnPercent)} num-tabular`}>
                          {cat.returnPercent >= 0 ? `+${cat.returnPercent}%` : `${cat.returnPercent}%`}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Dual Comparative Bars */}
                  <div className="cat-bars-dual">
                    {/* Invested Cost Bar */}
                    <div className="cat-bar-item cost-bar-item">
                      <div className="cat-bar-track">
                        <div 
                          className="cat-bar-fill cost-fill" 
                          style={{ width: `${costWidth}%` }} 
                        />
                      </div>
                      <span className="cat-bar-num num-tabular text-muted font-xs">
                        Cost: {formatINR(cat.investedCost)}
                      </span>
                    </div>

                    {/* Current Value Bar */}
                    {hasVal && (
                      <div className="cat-bar-item val-bar-item mt-1">
                        <div className="cat-bar-track">
                          <div 
                            className={`cat-bar-fill val-fill ${getPnlClass(cat.unrealizedPnl)}`} 
                            style={{ width: `${valWidth}%` }} 
                          />
                        </div>
                        <span className={`cat-bar-num num-tabular font-xs font-semibold ${getPnlClass(cat.unrealizedPnl)}`}>
                          Value: {formatINR(cat.currentValue)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── 3. TOP HOLDINGS CONCENTRATION & RISK CARD ─────────────────────── */}
      <div className="portfolio-card top-holdings-card">
        <div className="portfolio-card-header flex-between flex-wrap gap-2">
          <div>
            <span className="coverage-card-eyebrow">PORTFOLIO EXPOSURE</span>
            <h4 className="portfolio-card-title mt-0.5">Top Holdings Concentration</h4>
            <div className="portfolio-card-sub text-muted font-xs">
              Top 5 positions account for <strong className="text-primary num-tabular">{topHoldings.top5TotalShare}%</strong> of active portfolio value
            </div>
          </div>

          {topHoldings.hasConcentrationRisk && (
            <span className="concentration-warning-pill font-xs">
              ⚠️ Concentration Notice: Position &gt; 25%
            </span>
          )}
        </div>

        <div className="top-holdings-list mt-2.5">
          {topHoldings.items.map((item, idx) => (
            <div 
              key={item.id} 
              className="top-holding-row clickable"
              onClick={() => onSelectPosition && onSelectPosition(item.rawPosition)}
              title="Click to inspect holding details"
            >
              <div className="top-holding-rank-box">
                <span className="top-holding-rank">#{idx + 1}</span>
              </div>

              <div className="top-holding-info-box">
                <div className="top-holding-name-row flex-between align-center">
                  <div className="flex-gap-xs align-center">
                    <span className="top-holding-title font-sm font-semibold">{item.name}</span>
                    {item.subAccount && <span className="platform-tag">{item.subAccount}</span>}
                  </div>
                  <div className="top-holding-val-row num-tabular text-right">
                    <strong className="text-primary font-sm">{formatINR(item.currentVal)}</strong>
                    <span className="top-holding-pct-pill num-tabular font-bold ml-2">{item.sharePct}%</span>
                  </div>
                </div>

                {/* Concentration Bar */}
                <div className="top-holding-bar-wrap mt-1">
                  <div 
                    className="top-holding-bar-fill" 
                    style={{ width: `${Math.min(100, Math.max(4, item.sharePct))}%` }} 
                  />
                </div>

                <div className="top-holding-sub-row flex-between font-xs mt-1">
                  <span className="text-muted num-tabular">Cost: {formatINR(item.cost)}</span>
                  {item.pnl !== null ? (
                    <span className={`num-tabular font-semibold ${getPnlClass(item.pnl)}`}>
                      {formatSignedCurrency(item.pnl)} ({item.pnlPct >= 0 ? `+${item.pnlPct}%` : `${item.pnlPct}%`})
                    </span>
                  ) : (
                    <span className="text-muted">Awaiting price</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

