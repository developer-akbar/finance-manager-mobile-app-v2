import React, { useState, useMemo } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { formatINR } from '../../../utils/format.js';
import { getInvestmentDisplayMetrics } from '../../../utils/portfolioAggregation.js';

const ALLOCATION_PALETTE = [
  '#6366F1', '#06B6D4', '#10B981', '#F59E0B', '#EC4899', 
  '#8B5CF6', '#3B82F6', '#14B8A6', '#F97316', '#64748B', '#A855F7'
];

export default function PortfolioAllocation({ 
  positions = [], 
  valuationProvider, 
  valuationVersion 
}) {
  const [groupBy, setGroupBy] = useState('category'); // 'category' | 'fund' | 'platform' | 'account'
  const [basis, setBasis] = useState('value'); // 'value' (Current Market Value) | 'cost' (Invested Cost)

  const activePositions = useMemo(() => {
    return positions.filter(p => p.status === 'ACTIVE' && (p.remainingCostBasis > 0 || p.currentUnits > 0));
  }, [positions]);

  // Check valuation statistics across active positions
  const valuationStats = useMemo(() => {
    let valuedCount = 0;
    let totalCount = activePositions.length;
    let totalValuedAmount = 0;
    let unvaluedCostAmount = 0;

    for (const p of activePositions) {
      const val = valuationProvider ? valuationProvider.getValuation(p) : p.valuation;
      if (val && val.isValued && typeof val.currentValue === 'number' && val.currentValue > 0) {
        valuedCount++;
        totalValuedAmount += val.currentValue;
      } else {
        unvaluedCostAmount += (p.remainingCostBasis || 0);
      }
    }

    const isFullyValued = totalCount > 0 && valuedCount === totalCount;
    const hasPartialValuation = valuedCount > 0;

    return {
      valuedCount,
      totalCount,
      isFullyValued,
      hasPartialValuation,
      totalValuedAmount: Math.round(totalValuedAmount * 100) / 100,
      unvaluedCostAmount: Math.round(unvaluedCostAmount * 100) / 100
    };
  }, [activePositions, valuationProvider, valuationVersion]);

  // If user selected 'value' basis but 0 positions are valued, fallback visually to cost
  const effectiveBasis = (basis === 'value' && !valuationStats.hasPartialValuation) ? 'cost' : basis;

  const chartData = useMemo(() => {
    const map = {};

    for (const p of activePositions) {
      let key = '';
      if (groupBy === 'category') {
        const meta = getInvestmentDisplayMetrics(p);
        key = meta.assetType === 'MUTUAL_FUND' 
          ? 'Mutual Funds' 
          : meta.assetType === 'ETF' 
            ? 'Exchange Traded Funds' 
            : 'Equity Shares';
      } else if (groupBy === 'fund') {
        key = p.note || p.security || p.isin || 'Unknown Security';
      } else if (groupBy === 'platform') {
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
          // Preserve unvalued holding at cost basis so it never disappears or converts to ₹0
          amount = p.remainingCostBasis || 0;
        }
      } else {
        amount = p.remainingCostBasis || 0;
      }

      if (!map[key]) {
        map[key] = {
          name: key,
          value: 0,
          count: 0
        };
      }
      map[key].value += amount;
      map[key].count += 1;
    }

    const total = Object.values(map).reduce((sum, item) => sum + item.value, 0);
    if (total === 0) return [];

    const sorted = Object.values(map)
      .map(item => ({
        name: item.name,
        value: Math.round(item.value * 100) / 100,
        count: item.count,
        percent: ((item.value / total) * 100).toFixed(1)
      }))
      .sort((a, b) => b.value - a.value);

    if (sorted.length <= 6) {
      return sorted;
    }

    const top5 = sorted.slice(0, 5);
    const others = sorted.slice(5);
    const othersValue = Math.round(others.reduce((sum, item) => sum + item.value, 0) * 100) / 100;
    const othersPercent = ((othersValue / total) * 100).toFixed(1);
    const othersCount = others.reduce((sum, item) => sum + item.count, 0);

    return [
      ...top5,
      {
        name: `Others (${othersCount} holdings)`,
        value: othersValue,
        percent: othersPercent,
        count: othersCount
      }
    ];
  }, [activePositions, groupBy, effectiveBasis, valuationProvider, valuationVersion]);

  const totalAmount = useMemo(() => {
    return chartData.reduce((sum, item) => sum + item.value, 0);
  }, [chartData]);

  if (!chartData.length) {
    return null;
  }

  return (
    <div className="portfolio-card allocation-card">
      <div className="portfolio-card-header flex-between flex-wrap gap-2">
        <div>
          <h4 className="portfolio-card-title">Portfolio Allocation</h4>
          <div className="portfolio-card-sub">
            {effectiveBasis === 'value' 
              ? 'Composition by Current Market Value' 
              : 'Composition by Invested Cost (Principal)'}
          </div>
        </div>

        <div className="allocation-control-pills flex-gap-xs">
          {/* Basis Toggle: Current Value vs Invested Cost */}
          <div className="portfolio-pill-selector basis-selector">
            <button 
              className={`portfolio-pill ${basis === 'value' ? 'active' : ''}`}
              onClick={() => setBasis('value')}
              title={valuationStats.hasPartialValuation ? 'View allocation by live market value' : 'Valuations unavailable'}
            >
              Current Value
            </button>
            <button 
              className={`portfolio-pill ${basis === 'cost' ? 'active' : ''}`}
              onClick={() => setBasis('cost')}
              title="View allocation by invested cost basis"
            >
              Invested Cost
            </button>
          </div>

          {/* Grouping Dimension Toggle */}
          <div className="portfolio-pill-selector">
            <button 
              className={`portfolio-pill ${groupBy === 'category' ? 'active' : ''}`}
              onClick={() => setGroupBy('category')}
            >
              Category
            </button>
            <button 
              className={`portfolio-pill ${groupBy === 'fund' ? 'active' : ''}`}
              onClick={() => setGroupBy('fund')}
            >
              Scheme
            </button>
            <button 
              className={`portfolio-pill ${groupBy === 'platform' ? 'active' : ''}`}
              onClick={() => setGroupBy('platform')}
            >
              Platform
            </button>
            <button 
              className={`portfolio-pill ${groupBy === 'account' ? 'active' : ''}`}
              onClick={() => setGroupBy('account')}
            >
              Account
            </button>
          </div>
        </div>
      </div>

      {/* Valuation Notice Banner if Partial Valuation or Fallback */}
      {effectiveBasis === 'value' && !valuationStats.isFullyValued && valuationStats.hasPartialValuation && (
        <div className="allocation-val-notice text-xs text-muted">
          <span className="coverage-badge orange">
            ℹ️ {valuationStats.valuedCount} of {valuationStats.totalCount} holdings valued
          </span>
          <span className="ml-1.5">
            Allocation uses live market values; unvalued holdings are preserved at cost basis.
          </span>
        </div>
      )}

      {basis === 'value' && !valuationStats.hasPartialValuation && (
        <div className="allocation-val-notice text-xs text-muted">
          <span className="coverage-badge gray">
            ℹ️ Live valuations unavailable · Showing invested cost basis
          </span>
        </div>
      )}

      <div className="allocation-chart-content">
        <div className="allocation-pie-wrap" style={{ width: 184, height: 184 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={chartData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={54}
                outerRadius={82}
                paddingAngle={2}
              >
                {chartData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={ALLOCATION_PALETTE[index % ALLOCATION_PALETTE.length]} />
                ))}
              </Pie>
              <Tooltip 
                formatter={(val) => [formatINR(val), effectiveBasis === 'value' ? 'Current Value' : 'Invested Cost']}
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
              {effectiveBasis === 'value' ? 'Total Value' : 'Total Cost'}
            </span>
            <span className="allocation-center-val num-tabular">{formatINR(totalAmount)}</span>
          </div>
        </div>

        <div className="allocation-legend-list">
          {chartData.map((item, index) => (
            <div key={item.name} className="allocation-legend-item">
              <span 
                className="allocation-legend-dot" 
                style={{ backgroundColor: ALLOCATION_PALETTE[index % ALLOCATION_PALETTE.length] }} 
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
  );
}
