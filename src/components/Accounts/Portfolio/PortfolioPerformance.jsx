import React, { useMemo } from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { formatINR } from '../../../utils/format.js';
import { parseMutualFundTransaction } from '../../../utils/mutualFundPositionEngine.js';
import { parseTxnFields } from '../../../utils/brokerageAccounting.js';
import { formatSignedCurrency, formatSignedPercent, getPnlClass } from '../../../utils/portfolioAggregation.js';

export default function PortfolioPerformance({ 
  positions = [], 
  transactions = [], 
  scopeFilter = 'personal', 
  accountFilter = 'all', 
  platformFilter = 'all',
  summaryMetrics = null 
}) {
  // 1. Calculate Realized P&L and metrics from filtered positions
  const { totalRealized, topRealizedPerformer, activeCostBasis, valuedUnrealizedPnl, valuedReturnPercent, isFullyValued, hasPartialValuation } = useMemo(() => {
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

  // 2. Chronological Time-Series Chart Data respecting Scope -> Account -> Platform filters
  const timeSeriesData = useMemo(() => {
    const events = [];

    const parseDate = (s) => {
      if (!s) return new Date(0);
      const parts = String(s).split('/');
      if (parts.length === 3) return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
      return new Date(s);
    };

    // Extract historical cash events directly from already-scoped/filtered positions
    for (const pos of positions) {
      // 1. BUY lots
      if (Array.isArray(pos.buyLots)) {
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
              pnlDelta: 0
            });
          }
        }
      } else if (Array.isArray(pos.txns)) {
        for (const t of pos.txns) {
          const dStr = t.date || t.Date || '';
          const dObj = parseDate(dStr);
          if (isNaN(dObj.getTime()) || dObj.getTime() === 0) continue;
          const isBuy = (t.action || t.type || '').toUpperCase() === 'BUY';
          const cost = parseFloat(t.costBasis || t.tradeValue || t.amount || 0);
          events.push({
            dateObj: dObj,
            dateLabel: dStr,
            costDelta: isBuy ? cost : -cost,
            pnlDelta: !isBuy ? parseFloat(t.realizedPnl || 0) : 0
          });
        }
      }

      // 2. SELL records
      if (Array.isArray(pos.sellRecords)) {
        for (const s of pos.sellRecords) {
          const dStr = s.date || s.Date || pos.lastTransactionDate || '';
          const dObj = parseDate(dStr);
          if (isNaN(dObj.getTime()) || dObj.getTime() === 0) continue;
          events.push({
            dateObj: dObj,
            dateLabel: dStr,
            costDelta: -(parseFloat(s.costBasis) || 0),
            pnlDelta: parseFloat(s.realizedPnl || 0)
          });
        }
      }
    }

    if (events.length === 0) return [];

    events.sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());

    let cumInvested = 0;
    let cumRealized = 0;
    const pointsMap = new Map();

    for (const ev of events) {
      cumInvested += ev.costDelta;
      cumRealized += ev.pnlDelta;

      const key = ev.dateLabel;
      pointsMap.set(key, {
        date: key,
        invested: Math.max(0, Math.round(cumInvested)),
        realized: Math.round(cumRealized * 100) / 100
      });
    }

    const series = Array.from(pointsMap.values());
    if (series.length > 30) {
      const step = Math.ceil(series.length / 30);
      return series.filter((_, idx) => idx % step === 0 || idx === series.length - 1);
    }

    return series;
  }, [positions]);

  return (
    <div className="portfolio-card performance-card">
      <div className="portfolio-card-header flex-between">
        <div>
          <h4 className="portfolio-card-title">Investment & Realized P&L</h4>
          <div className="portfolio-card-sub">
            Capital deployed and realized gains/losses over time
          </div>
          <div className="portfolio-chart-helper-note">
            ℹ️ Historical capital deployed (FIFO cost basis) and cumulative realized gains over time. Does not represent current market value / NAV fluctuation.
          </div>
        </div>
      </div>

      {/* Analytics Hero Strip — Compact 3-metric analytics block */}
      <div className="performance-metrics-strip">
        {/* Metric 1: Capital Deployed / Invested */}
        <div className="perf-metric-box">
          <div className="perf-metric-lbl">ACTIVE INVESTED COST</div>
          <div className="perf-metric-val num-tabular text-primary">
            {formatINR(activeCostBasis)}
          </div>
          <div className="perf-metric-sub">Capital currently deployed</div>
        </div>

        {/* Metric 2: Unrealized P&L */}
        <div className="perf-metric-box">
          <div className="perf-metric-lbl">UNREALIZED P&L</div>
          <div className="perf-metric-val num-tabular">
            {valuedUnrealizedPnl !== null ? (
              <span className={getPnlClass(valuedUnrealizedPnl)}>
                {formatSignedCurrency(valuedUnrealizedPnl)}
              </span>
            ) : (
              <span className="text-muted">—</span>
            )}
          </div>
          <div className="perf-metric-sub">
            {valuedReturnPercent !== null && (
              <div className={`perf-metric-pct ${getPnlClass(valuedUnrealizedPnl)} font-semibold`}>
                {formatSignedPercent(valuedReturnPercent)}
              </div>
            )}
            <div className="perf-metric-coverage">
              {isFullyValued ? '100% valued' : hasPartialValuation ? 'Partial valuation' : 'Awaiting live prices'}
            </div>
          </div>
        </div>

        {/* Metric 3: Realized P&L */}
        <div className="perf-metric-box">
          <div className="perf-metric-lbl">REALIZED P&L</div>
          <div className={`perf-metric-val num-tabular ${getPnlClass(totalRealized)}`}>
            {totalRealized !== 0 ? formatSignedCurrency(totalRealized) : '₹0'}
          </div>
          <div className="perf-metric-sub">
            {topRealizedPerformer ? `Best: ${topRealizedPerformer.note || topRealizedPerformer.security} (+${formatINR(topRealizedPerformer.realizedPnl)})` : 'Across all exits'}
          </div>
        </div>
      </div>

      {/* Historical Growth Chart */}
      <div className="performance-chart-container">
        <div className="chart-legend-row performance-chart-legend">
          <span style={{ color: '#4F46E5', fontWeight: 600 }}>■ Cumulative Invested Cost</span>
          <span style={{ color: '#10B981', fontWeight: 600 }}>■ Cumulative Realized P&L</span>
        </div>
        {timeSeriesData.length > 0 ? (
          <ResponsiveContainer width="100%" height={200} minWidth={0} minHeight={200}>
            <AreaChart data={timeSeriesData} margin={{ top: 10, right: 15, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="colorInvested" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#4F46E5" stopOpacity={0.3}/>
                  <stop offset="95%" stopColor="#4F46E5" stopOpacity={0}/>
                </linearGradient>
                <linearGradient id="colorRealized" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10B981" stopOpacity={0.3}/>
                  <stop offset="95%" stopColor="#10B981" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} width={45} />
              <Tooltip 
                formatter={(val, name) => [formatINR(val), name === 'invested' ? 'Cumulative Invested Cost' : 'Cumulative Realized P&L']}
                contentStyle={{ background: 'var(--bg-card)', borderColor: 'var(--border)', borderRadius: 8, fontSize: '0.78rem' }}
              />
              <Area type="monotone" dataKey="invested" stroke="#4F46E5" fillOpacity={1} fill="url(#colorInvested)" strokeWidth={2} />
              <Area type="monotone" dataKey="realized" stroke="#10B981" fillOpacity={1} fill="url(#colorRealized)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="portfolio-performance-empty">
            <div className="performance-empty-title">Historical Trajectory Unavailable for Selected Filter</div>
          </div>
        )}
      </div>
    </div>
  );
}
