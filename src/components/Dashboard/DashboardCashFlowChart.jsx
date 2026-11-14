import React, { useState, useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { formatINR, formatINRCompact } from '../../utils/format.js';

function DashboardCashFlowChart({ analytics, showPrivacy }) {
  const [chartView, setChartView] = useState('cashflow'); // 'cashflow' | 'networth'
  const [period, setPeriod] = useState('6M'); // '6M' | '12M' | 'Yearly'

  const { timeSeries = {} } = analytics || {};

  const currentData = useMemo(() => {
    if (period === '6M') return timeSeries.series6M || [];
    if (period === '12M') return timeSeries.series12M || [];
    return timeSeries.seriesYearly || [];
  }, [period, timeSeries]);

  const isNetWorthUnavailable = useMemo(() => {
    if (chartView !== 'networth') return false;
    if (!currentData || currentData.length === 0) return true;
    if (period === 'Yearly' && timeSeries.isYearlyNetWorthUnavailable) return true;
    return currentData.every(d => !d.netWorth);
  }, [chartView, currentData, period, timeSeries]);

  // Custom polished SaaS Tooltip matching Dribbble style
  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload || !payload.length) return null;
    const item = payload[0]?.payload;

    return (
      <div className="dash-chart-custom-tooltip">
        <div className="dash-tooltip-header">
          {item?.fullLabel || label}
        </div>
        <div className="dash-tooltip-rows">
          {chartView === 'cashflow' ? (
            <>
              <div className="dash-tooltip-row">
                <span className="dash-tt-dot" style={{ background: '#0075FF' }} />
                <span className="dash-tt-lbl">Income</span>
                <span className="dash-tt-val income">{showPrivacy ? formatINR(item?.income || 0) : '••••'}</span>
              </div>
              <div className="dash-tooltip-row">
                <span className="dash-tt-dot" style={{ background: '#EE5D50' }} />
                <span className="dash-tt-lbl">Expense</span>
                <span className="dash-tt-val expense">{showPrivacy ? formatINR(item?.expense || 0) : '••••'}</span>
              </div>
              <div className="dash-tooltip-row">
                <span className="dash-tt-dot" style={{ background: '#01B574' }} />
                <span className="dash-tt-lbl">Net Savings</span>
                <span className="dash-tt-val" style={{ color: (item?.savings || 0) >= 0 ? '#01B574' : '#EE5D50' }}>
                  {showPrivacy ? formatINR(item?.savings || 0) : '••••'}
                </span>
              </div>
            </>
          ) : (
            <div className="dash-tooltip-row">
              <span className="dash-tt-dot" style={{ background: '#00D2D3' }} />
              <span className="dash-tt-lbl">Net Worth</span>
              <span className="dash-tt-val income">{showPrivacy ? formatINR(item?.netWorth || 0) : '••••'}</span>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="dash-bento-card dash-chart-bento-card">
      <div className="dash-chart-card-header">
        <div className="dash-chart-header-left">
          <div className="dash-bento-card-title">
            {chartView === 'cashflow' ? 'Cash Flow Overview' : 'Net Worth Trajectory'}
          </div>
          <div className="dash-bento-card-sub">
            {chartView === 'cashflow' ? 'Monthly income, expenses & net cash flow' : 'Historical net worth progression'}
          </div>
        </div>

        <div className="dash-chart-controls">
          {/* Chart Type Toggle */}
          <div className="dash-pill-toggle-group">
            <button
              type="button"
              className={`dash-pill-btn ${chartView === 'cashflow' ? 'active' : ''}`}
              onClick={() => setChartView('cashflow')}
            >
              Cash Flow
            </button>
            <button
              type="button"
              className={`dash-pill-btn ${chartView === 'networth' ? 'active' : ''}`}
              onClick={() => setChartView('networth')}
            >
              Net Worth
            </button>
          </div>

          {/* Period Selector */}
          <div className="dash-pill-toggle-group">
            <button
              type="button"
              className={`dash-pill-btn ${period === '6M' ? 'active' : ''}`}
              onClick={() => setPeriod('6M')}
            >
              6M
            </button>
            <button
              type="button"
              className={`dash-pill-btn ${period === '12M' ? 'active' : ''}`}
              onClick={() => setPeriod('12M')}
            >
              12M
            </button>
            <button
              type="button"
              className={`dash-pill-btn ${period === 'Yearly' ? 'active' : ''}`}
              onClick={() => setPeriod('Yearly')}
            >
              Yearly
            </button>
          </div>
        </div>
      </div>

      {/* Chart Canvas Area */}
      <div className="dash-chart-body">
        {chartView === 'cashflow' ? (
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={currentData} margin={{ top: 12, right: 10, left: -14, bottom: 0 }}>
              <defs>
                <linearGradient id="incomeAreaGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#0075FF" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="#0075FF" stopOpacity={0.0} />
                </linearGradient>
                <linearGradient id="expenseAreaGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#EE5D50" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#EE5D50" stopOpacity={0.0} />
                </linearGradient>
                <linearGradient id="savingsAreaGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#01B574" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#01B574" stopOpacity={0.0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--dash-grid-color, rgba(255, 255, 255, 0.05))" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={v => formatINRCompact(v)}
                width={44}
              />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="income"
                name="Income"
                stroke="#0075FF"
                strokeWidth={2.5}
                fillOpacity={1}
                fill="url(#incomeAreaGrad)"
                isAnimationActive={false}
                activeDot={{ r: 5, stroke: '#0075FF', strokeWidth: 2, fill: '#ffffff' }}
              />
              <Area
                type="monotone"
                dataKey="expense"
                name="Expenses"
                stroke="#EE5D50"
                strokeWidth={2.2}
                fillOpacity={1}
                fill="url(#expenseAreaGrad)"
                isAnimationActive={false}
                activeDot={{ r: 5, stroke: '#EE5D50', strokeWidth: 2, fill: '#ffffff' }}
              />
              <Area
                type="monotone"
                dataKey="savings"
                name="Net Savings"
                stroke="#01B574"
                strokeWidth={2}
                strokeDasharray="4 4"
                fillOpacity={1}
                fill="url(#savingsAreaGrad)"
                isAnimationActive={false}
                activeDot={{ r: 4, stroke: '#01B574', strokeWidth: 2, fill: '#ffffff' }}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : isNetWorthUnavailable ? (
          <div className="dash-empty-state-chart">
            <span className="dash-empty-icon">📊</span>
            <div className="dash-empty-title">Historical Net Worth Reconstruction Unavailable</div>
            <div className="dash-empty-sub">
              Insufficient historical balance records to reliably reconstruct net worth for this period without fabricating data.
            </div>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={currentData} margin={{ top: 12, right: 10, left: -14, bottom: 0 }}>
              <defs>
                <linearGradient id="nwAreaGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#00D2D3" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#0075FF" stopOpacity={0.0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--dash-grid-color, rgba(255, 255, 255, 0.05))" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={v => formatINRCompact(v)}
                width={44}
              />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="netWorth"
                name="Net Worth"
                stroke="#00D2D3"
                strokeWidth={3}
                fillOpacity={1}
                fill="url(#nwAreaGrad)"
                isAnimationActive={false}
                activeDot={{ r: 6, stroke: '#00D2D3', strokeWidth: 2, fill: '#ffffff' }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Chart Footer Legend */}
      <div className="dash-chart-footer-legend">
        {chartView === 'cashflow' ? (
          <>
            <div className="dash-legend-item">
              <span className="dash-legend-dot" style={{ background: '#0075FF' }} />
              <span>Income</span>
            </div>
            <div className="dash-legend-item">
              <span className="dash-legend-dot" style={{ background: '#EE5D50' }} />
              <span>Expenses</span>
            </div>
            <div className="dash-legend-item">
              <span className="dash-legend-dot" style={{ background: '#01B574' }} />
              <span>Net Savings</span>
            </div>
          </>
        ) : (
          <div className="dash-legend-item">
            <span className="dash-legend-dot" style={{ background: '#00D2D3' }} />
            <span>Net Worth (Cumulative)</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default React.memo(DashboardCashFlowChart);
