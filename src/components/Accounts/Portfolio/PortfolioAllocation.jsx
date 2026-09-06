import React, { useState, useMemo } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { formatINR } from '../../../utils/format.js';

const COLORS = [
  '#4F46E5', '#06B6D4', '#10B981', '#F59E0B', '#EC4899', 
  '#8B5CF6', '#3B82F6', '#14B8A6', '#F97316', '#6366F1'
];

export default function PortfolioAllocation({ positions = [] }) {
  const [groupBy, setGroupBy] = useState('fund'); // 'fund' | 'platform' | 'account'

  const activePositions = useMemo(() => {
    return positions.filter(p => p.status === 'ACTIVE' && p.remainingCostBasis > 0);
  }, [positions]);

  const chartData = useMemo(() => {
    const map = {};
    for (const p of activePositions) {
      let key = '';
      if (groupBy === 'fund') {
        key = p.note || p.security || p.isin;
      } else if (groupBy === 'platform') {
        key = p.subAccount || 'Default';
      } else {
        key = p.investmentAccount || 'Liquid Mutual Funds';
      }
      map[key] = (map[key] || 0) + p.remainingCostBasis;
    }

    const total = Object.values(map).reduce((sum, v) => sum + v, 0);
    if (total === 0) return [];

    const sorted = Object.entries(map)
      .map(([name, value]) => ({
        name,
        value: Math.round(value * 100) / 100,
        percent: ((value / total) * 100).toFixed(1)
      }))
      .sort((a, b) => b.value - a.value);

    if (sorted.length <= 6) {
      return sorted;
    }

    const top5 = sorted.slice(0, 5);
    const others = sorted.slice(5);
    const othersValue = Math.round(others.reduce((sum, item) => sum + item.value, 0) * 100) / 100;
    const othersPercent = ((othersValue / total) * 100).toFixed(1);

    return [
      ...top5,
      {
        name: `Others (${others.length} holdings)`,
        value: othersValue,
        percent: othersPercent
      }
    ];
  }, [activePositions, groupBy]);

  const totalCost = useMemo(() => {
    return chartData.reduce((sum, item) => sum + item.value, 0);
  }, [chartData]);

  if (!chartData.length) {
    return null;
  }

  return (
    <div className="portfolio-card allocation-card">
      <div className="portfolio-card-header">
        <div>
          <h4 className="portfolio-card-title">Portfolio Allocation</h4>
          <div className="portfolio-card-sub">Allocation by Invested Cost (Principal)</div>
        </div>
        <div className="portfolio-pill-selector">
          <button 
            className={`portfolio-pill ${groupBy === 'fund' ? 'active' : ''}`}
            onClick={() => setGroupBy('fund')}
          >
            By Fund
          </button>
          <button 
            className={`portfolio-pill ${groupBy === 'platform' ? 'active' : ''}`}
            onClick={() => setGroupBy('platform')}
          >
            By Platform
          </button>
          <button 
            className={`portfolio-pill ${groupBy === 'account' ? 'active' : ''}`}
            onClick={() => setGroupBy('account')}
          >
            By Account
          </button>
        </div>
      </div>

      <div className="allocation-chart-content">
        <div className="allocation-pie-wrap" style={{ width: 180, height: 180 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={chartData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={52}
                outerRadius={80}
                paddingAngle={2}
              >
                {chartData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip 
                formatter={(val) => [formatINR(val), 'Invested Cost']}
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
            <span className="allocation-center-lbl">Total Cost</span>
            <span className="allocation-center-val">{formatINR(totalCost)}</span>
          </div>
        </div>

        <div className="allocation-legend-list">
          {chartData.slice(0, 6).map((item, index) => (
            <div key={item.name} className="allocation-legend-item">
              <span 
                className="allocation-legend-dot" 
                style={{ backgroundColor: COLORS[index % COLORS.length] }} 
              />
              <span className="allocation-legend-name" title={item.name}>
                {item.name}
              </span>
              <span className="allocation-legend-pct">{item.percent}%</span>
              <span className="allocation-legend-val">{formatINR(item.value)}</span>
            </div>
          ))}
          {chartData.length > 6 && (
            <div className="allocation-legend-more">
              + {chartData.length - 6} more positions
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
