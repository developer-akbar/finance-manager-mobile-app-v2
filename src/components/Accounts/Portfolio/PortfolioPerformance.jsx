import React, { useState, useMemo } from 'react';
import { 
  ResponsiveContainer, 
  AreaChart, 
  Area, 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  Tooltip, 
  CartesianGrid 
} from 'recharts';
import { formatINR } from '../../../utils/format.js';
import { formatSignedCurrency, formatSignedPercent, getPnlClass } from '../../../utils/portfolioAggregation.js';

export default function PortfolioPerformance({ 
  positions = [], 
  transactions = [], 
  scopeFilter = 'personal', 
  accountFilter = 'all', 
  platformFilter = 'all',
  summaryMetrics = null 
}) {
  const [timeRange, setTimeRange] = useState('ALL'); // '1M' | '3M' | '6M' | '1Y' | 'ALL'
  const [chartView, setChartView] = useState('cumulative'); // 'cumulative' | 'monthly'

  // 1. Calculate Realized P&L and metrics from filtered positions
  const { 
    totalRealized, 
    topRealizedPerformer, 
    activeCostBasis, 
    valuedUnrealizedPnl, 
    valuedReturnPercent, 
    isFullyValued, 
    hasPartialValuation 
  } = useMemo(() => {
    let realized = 0;
    let bestPerformer = null;
    let activeCost = 0;

    for (const p of positions) {
      if (p.status === 'ACTIVE') {
        activeCost += (p.remainingCostBasis || 0);
      }
      if (p.realizedPnl !== 0) {
        realized += p.realizedPnl;
      }
      if (p.status === 'REDEEMED' && p.realizedPnl > 0) {
        if (!bestPerformer || p.realizedPnl > bestPerformer.realizedPnl) {
          bestPerformer = p;
        }
      }
    }

    return {
      totalRealized: Math.round(realized * 100) / 100,
      topRealizedPerformer: bestPerformer,
      activeCostBasis: summaryMetrics?.activeCostBasis ?? Math.round(activeCost * 100) / 100,
      valuedUnrealizedPnl: summaryMetrics?.valuedUnrealizedPnl ?? null,
      valuedReturnPercent: summaryMetrics?.valuedReturnPercent ?? null,
      isFullyValued: summaryMetrics?.isFullyValued ?? false,
      hasPartialValuation: summaryMetrics?.hasPartialValuation ?? false
    };
  }, [positions, summaryMetrics]);

  // 2. State for Capital Series basis: 'net' (Active Cost Basis) vs 'gross' (Cumulative Total Inflows)
  const [metricBasis, setMetricBasis] = useState('net'); // 'net' | 'gross'

  // 3. Parse all historical cash events directly from scoped positions & FIFO records
  const allEvents = useMemo(() => {
    const events = [];

    const parseDate = (s) => {
      if (!s) return new Date(0);
      const parts = String(s).split('/');
      if (parts.length === 3) return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
      return new Date(s);
    };

    for (const pos of positions) {
      // 1. BUY lots (Gross Capital Inflows)
      if (Array.isArray(pos.buyLots) && pos.buyLots.length > 0) {
        for (const lot of pos.buyLots) {
          const dStr = lot.date || lot.Date || pos.firstBuyDate || '';
          const dObj = parseDate(dStr);
          if (isNaN(dObj.getTime()) || dObj.getTime() === 0) continue;
          const cost = parseFloat(lot.costBasis) || (parseFloat(lot.units || 0) * parseFloat(lot.unitCost || 0)) || 0;
          if (cost > 0) {
            events.push({
              dateObj: dObj,
              dateLabel: dStr,
              costDelta: cost,
              pnlDelta: 0,
              type: 'BUY'
            });
          }
        }
      } else if (Array.isArray(pos.txns)) {
        for (const t of pos.txns) {
          const isBuy = (t.action || t.type || '').toUpperCase() === 'BUY' || (t.action || t.type || '').toUpperCase() === 'OPENING_LOT';
          if (isBuy) {
            const dStr = t.date || t.Date || '';
            const dObj = parseDate(dStr);
            if (isNaN(dObj.getTime()) || dObj.getTime() === 0) continue;
            const cost = parseFloat(t.costBasis || t.tradeValue || t.amount || 0);
            if (cost > 0) {
              events.push({
                dateObj: dObj,
                dateLabel: dStr,
                costDelta: cost,
                pnlDelta: 0,
                type: 'BUY'
              });
            }
          }
        }
      }

      // 2. SELL records (Redemptions, Consumed FIFO Cost & Realized P&L)
      if (Array.isArray(pos.sellRecords) && pos.sellRecords.length > 0) {
        for (const s of pos.sellRecords) {
          const dStr = s.date || s.Date || pos.lastTransactionDate || pos.exitDate || '';
          const dObj = parseDate(dStr);
          if (isNaN(dObj.getTime()) || dObj.getTime() === 0) continue;
          const consumedCost = parseFloat(s.consumedCostBasis !== undefined ? s.consumedCostBasis : (s.costBasis || 0));
          const pnl = parseFloat(s.realizedPnl || 0);
          events.push({
            dateObj: dObj,
            dateLabel: dStr,
            costDelta: -consumedCost, // subtract redeemed cost basis from net capital
            pnlDelta: pnl, // add realized profit/loss
            type: 'SELL'
          });
        }
      } else if (pos.status === 'REDEEMED' && (pos.sellCostBasis > 0 || pos.realizedPnl !== 0)) {
        // Fallback for redeemed position without individual sellRecords
        const dStr = pos.exitDate || pos.lastTransactionDate || pos.firstBuyDate || '';
        const dObj = parseDate(dStr);
        if (!isNaN(dObj.getTime()) && dObj.getTime() > 0) {
          events.push({
            dateObj: dObj,
            dateLabel: dStr,
            costDelta: -(parseFloat(pos.sellCostBasis || pos.buyCost || 0)),
            pnlDelta: parseFloat(pos.realizedPnl || 0),
            type: 'SELL'
          });
        }
      } else if (Array.isArray(pos.txns)) {
        for (const t of pos.txns) {
          const isSell = (t.action || t.type || '').toUpperCase() === 'SELL';
          if (isSell) {
            const dStr = t.date || t.Date || '';
            const dObj = parseDate(dStr);
            if (isNaN(dObj.getTime()) || dObj.getTime() === 0) continue;
            events.push({
              dateObj: dObj,
              dateLabel: dStr,
              costDelta: -(parseFloat(t.consumedCostBasis || t.costBasis || t.tradeValue || 0)),
              pnlDelta: parseFloat(t.realizedPnl || 0),
              type: 'SELL'
            });
          }
        }
      }
    }

    events.sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());
    return events;
  }, [positions]);

  // 4. Time Filter Boundaries & Cumulative Sums
  const timeFilteredData = useMemo(() => {
    if (allEvents.length === 0) return { timeSeries: [], monthlySeries: [], periodDeployed: 0, finalNetCost: 0, finalGrossCost: 0, finalRealized: 0 };

    const now = new Date('2026-09-06'); // Reference date
    let cutoff = new Date(0);
    if (timeRange === '1M') cutoff = new Date(now.getTime() - (30 * 86400000));
    else if (timeRange === '3M') cutoff = new Date(now.getTime() - (90 * 86400000));
    else if (timeRange === '6M') cutoff = new Date(now.getTime() - (180 * 86400000));
    else if (timeRange === '1Y') cutoff = new Date(now.getTime() - (365 * 86400000));

    let runningNetCost = 0;
    let runningGrossCost = 0;
    let runningRealized = 0;
    const pointsMap = new Map();
    let periodDeployed = 0;
    const monthMap = new Map();

    for (const ev of allEvents) {
      runningNetCost += ev.costDelta;
      if (ev.costDelta > 0) runningGrossCost += ev.costDelta;
      runningRealized += ev.pnlDelta;

      const isInside = ev.dateObj >= cutoff;
      if (isInside) {
        if (ev.type === 'BUY' && ev.costDelta > 0) {
          periodDeployed += ev.costDelta;
        }

        const mKey = `${ev.dateObj.getFullYear()}-${String(ev.dateObj.getMonth() + 1).padStart(2, '0')}`;
        const mLabel = ev.dateObj.toLocaleString('en-IN', { month: 'short', year: '2-digit' });
        if (!monthMap.has(mKey)) {
          monthMap.set(mKey, { month: mLabel, invested: 0, redeemed: 0, net: 0 });
        }
        const mItem = monthMap.get(mKey);
        if (ev.costDelta > 0) {
          mItem.invested += ev.costDelta;
          mItem.net += ev.costDelta;
        } else {
          mItem.redeemed += Math.abs(ev.costDelta);
          mItem.net += ev.costDelta;
        }

        const key = ev.dateLabel;
        pointsMap.set(key, {
          date: key,
          invested: metricBasis === 'gross' 
            ? Math.round(runningGrossCost) 
            : Math.max(0, Math.round(runningNetCost)),
          realized: Math.round(runningRealized * 100) / 100
        });
      }
    }

    let series = Array.from(pointsMap.values());
    if (series.length > 35) {
      const step = Math.ceil(series.length / 35);
      series = series.filter((_, idx) => idx % step === 0 || idx === series.length - 1);
    }

    const monthlySeries = Array.from(monthMap.values()).map(m => ({
      ...m,
      invested: Math.round(m.invested),
      redeemed: Math.round(m.redeemed),
      net: Math.round(m.net)
    }));

    return { 
      timeSeries: series, 
      monthlySeries, 
      periodDeployed: Math.round(periodDeployed),
      finalNetCost: Math.round(runningNetCost),
      finalGrossCost: Math.round(runningGrossCost),
      finalRealized: Math.round(runningRealized * 100) / 100
    };
  }, [allEvents, timeRange, metricBasis]);

  return (
    <div className="portfolio-card performance-card">
      <div className="portfolio-card-header flex-between flex-wrap gap-2">
        <div>
          <span className="coverage-card-eyebrow">HISTORICAL CAPITAL & TRAJECTORY</span>
          <h4 className="portfolio-card-title mt-0.5">Investment & Realized Performance</h4>
          <div className="portfolio-card-sub">
            Capital deployed and realized gains/losses over time
          </div>
        </div>

        {/* View Toggle (Cumulative vs Monthly Contributions) & Time Range Filter */}
        <div className="perf-chart-controls flex-gap-xs flex-wrap align-center">
          <div className="portfolio-pill-selector">
            <button 
              type="button"
              className={`portfolio-pill ${chartView === 'cumulative' ? 'active' : ''}`}
              onClick={() => setChartView('cumulative')}
            >
              Cumulative Growth
            </button>
            <button 
              type="button"
              className={`portfolio-pill ${chartView === 'monthly' ? 'active' : ''}`}
              onClick={() => setChartView('monthly')}
            >
              Monthly Inflows
            </button>
          </div>

          {chartView === 'cumulative' && (
            <div className="portfolio-pill-selector basis-filter-selector">
              <button 
                type="button"
                className={`portfolio-pill ${metricBasis === 'net' ? 'active' : ''}`}
                onClick={() => setMetricBasis('net')}
                title="Active Deployed Cost Basis after FIFO redemptions"
              >
                Net Invested
              </button>
              <button 
                type="button"
                className={`portfolio-pill ${metricBasis === 'gross' ? 'active' : ''}`}
                onClick={() => setMetricBasis('gross')}
                title="Total Lifetime Capital Inflows"
              >
                Gross Contributions
              </button>
            </div>
          )}

          <div className="portfolio-pill-selector time-filter-selector">
            {['1M', '3M', '6M', '1Y', 'ALL'].map(range => (
              <button 
                key={range}
                type="button"
                className={`portfolio-pill ${timeRange === range ? 'active' : ''}`}
                onClick={() => setTimeRange(range)}
              >
                {range}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Analytics Hero Strip — 3-metric analytics block */}
      <div className="performance-metrics-strip mt-2.5">
        <div className="perf-metric-box">
          <div className="perf-metric-lbl">ACTIVE INVESTED COST</div>
          <div className="perf-metric-val num-tabular text-primary font-bold">
            {formatINR(activeCostBasis)}
          </div>
          <div className="perf-metric-sub">
            {timeRange !== 'ALL' && timeFilteredData.periodDeployed > 0 
              ? `Deployed in period: ${formatINR(timeFilteredData.periodDeployed)}` 
              : 'Capital currently deployed'}
          </div>
        </div>

        <div className="perf-metric-box">
          <div className="perf-metric-lbl">UNREALIZED P&L</div>
          <div className="perf-metric-val num-tabular">
            {valuedUnrealizedPnl !== null ? (
              <span className={`font-bold ${getPnlClass(valuedUnrealizedPnl)}`}>
                {formatSignedCurrency(valuedUnrealizedPnl)}
              </span>
            ) : (
              <span className="text-muted">—</span>
            )}
          </div>
          <div className="perf-metric-sub">
            {valuedReturnPercent !== null && (
              <span className={`perf-metric-pct ${getPnlClass(valuedUnrealizedPnl)} font-semibold mr-1`}>
                {formatSignedPercent(valuedReturnPercent)}
              </span>
            )}
            <span className="perf-metric-coverage">
              {isFullyValued ? '· 100% valued' : hasPartialValuation ? '· Partial valuation' : '· Awaiting prices'}
            </span>
          </div>
        </div>

        <div className="perf-metric-box">
          <div className="perf-metric-lbl">REALIZED P&L</div>
          <div className={`perf-metric-val num-tabular font-bold ${getPnlClass(totalRealized)}`}>
            {totalRealized !== 0 ? formatSignedCurrency(totalRealized) : '₹0'}
          </div>
          <div className="perf-metric-sub">
            {topRealizedPerformer 
              ? `Best: ${topRealizedPerformer.note || topRealizedPerformer.security} (+${formatINR(topRealizedPerformer.realizedPnl)})` 
              : 'Across all closed positions'}
          </div>
        </div>
      </div>

      {/* Primary Chart Area */}
      <div className="performance-chart-container mt-3">
        {chartView === 'cumulative' ? (
          <>
            <div className="chart-legend-row performance-chart-legend mb-1.5">
              <span style={{ color: '#0075FF', fontWeight: 600 }}>{metricBasis === 'gross' ? '■ Gross Capital Contributed' : '■ Net Invested Capital (Cost Basis)'}</span>
              <span style={{ color: '#01B574', fontWeight: 600, marginLeft: 16 }}>■ Cumulative Realized P&L</span>
            </div>
            {timeFilteredData.timeSeries.length > 0 ? (
              <ResponsiveContainer width="100%" height={260} minWidth={0} minHeight={260}>
                <AreaChart data={timeFilteredData.timeSeries} margin={{ top: 10, right: 15, left: 0, bottom: 30 }}>
                  <defs>
                    <linearGradient id="colorInvested" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#0075FF" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#0075FF" stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="colorRealized" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#01B574" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#01B574" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} width={48} />
                  <Tooltip 
                    formatter={(val, name) => [
                      formatINR(val), 
                      name === 'invested' ? (metricBasis === 'gross' ? 'Gross Capital Contributed' : 'Net Invested Capital') : 'Cumulative Realized P&L'
                    ]}
                    contentStyle={{ 
                      background: 'var(--bg-card)', 
                      borderColor: 'var(--border)', 
                      borderRadius: 8, 
                      fontSize: '0.78rem',
                      color: 'var(--text-primary)' 
                    }}
                  />
                  <Area type="monotone" dataKey="invested" stroke="#0075FF" fillOpacity={1} fill="url(#colorInvested)" strokeWidth={2} />
                  <Area type="monotone" dataKey="realized" stroke="#01B574" fillOpacity={1} fill="url(#colorRealized)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="portfolio-performance-empty">
                <div className="performance-empty-title">No transactions recorded in the selected time range ({timeRange})</div>
              </div>
            )}
          </>
        ) : (
          /* Monthly Inflows / Contributions Bar Chart */
          <>
            <div className="chart-legend-row performance-chart-legend mb-1.5">
              <span style={{ color: '#0075FF', fontWeight: 600 }}>■ Monthly Invested Capital</span>
              <span style={{ color: '#00D2D3', fontWeight: 600, marginLeft: 16 }}>■ Net Capital Inflow</span>
            </div>
            {timeFilteredData.monthlySeries.length > 0 ? (
              <ResponsiveContainer width="100%" height={260} minWidth={0} minHeight={260}>
                <BarChart data={timeFilteredData.monthlySeries} margin={{ top: 10, right: 15, left: 0, bottom: 25 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                  <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} width={48} />
                  <Tooltip 
                    formatter={(val, name) => [
                      formatINR(val), 
                      name === 'invested' ? 'Capital Invested' : name === 'redeemed' ? 'Redemptions' : 'Net Inflow'
                    ]}
                    contentStyle={{ 
                      background: 'var(--bg-card)', 
                      borderColor: 'var(--border)', 
                      borderRadius: 8, 
                      fontSize: '0.78rem',
                      color: 'var(--text-primary)' 
                    }}
                  />
                  <Bar dataKey="invested" fill="#0075FF" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="net" fill="#00D2D3" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="portfolio-performance-empty">
                <div className="performance-empty-title">No monthly activity in the selected range</div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Analytical Transparency Architecture Notice */}
      <div className="performance-architecture-notice mt-3 font-xs text-muted">
        <div className="flex-gap-xs align-start">
          <span className="notice-icon">ℹ️</span>
          <div className="notice-content">
            <strong className="text-primary font-semibold block mb-0.5">Historical Portfolio Valuation Architecture Note</strong>
            Historical trajectories represent capital deployed (FIFO cost basis) and cumulative realized gains over time.
            Continuous daily historical portfolio market value curves require stored end-of-day NAV snapshots, which will be enabled once historical snapshot storage is integrated.
          </div>
        </div>
      </div>
    </div>
  );
}
