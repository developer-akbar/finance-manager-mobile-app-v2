import React, { useMemo } from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { formatINR } from '../../../utils/format.js';
import { parseMutualFundTransaction } from '../../../utils/mutualFundPositionEngine.js';
import { parseTxnFields } from '../../../utils/brokerageAccounting.js';

export default function PortfolioPerformance({ positions = [], transactions = [], isValued = false }) {
  // 1. Calculate Realized P&L breakdown
  const realizedBreakdown = useMemo(() => {
    const byAccount = {};
    const byPlatform = {};
    let totalRealized = 0;

    for (const p of positions) {
      if (p.realizedPnl !== 0) {
        totalRealized += p.realizedPnl;

        const acct = p.investmentAccount || 'Liquid Mutual Funds';
        byAccount[acct] = (byAccount[acct] || 0) + p.realizedPnl;

        const plat = p.subAccount || 'Default';
        byPlatform[plat] = (byPlatform[plat] || 0) + p.realizedPnl;
      }
    }

    return {
      totalRealized: Math.round(totalRealized * 100) / 100,
      byAccount,
      byPlatform
    };
  }, [positions]);

  // 2. Performers (Best Realized Investment)
  const performers = useMemo(() => {
    const redeemedWithPnL = positions
      .filter(p => p.status === 'REDEEMED')
      .sort((a, b) => b.realizedPnl - a.realizedPnl);

    return {
      topRedeemed: redeemedWithPnL.slice(0, 3),
      bottomRedeemed: redeemedWithPnL.slice(-3).reverse()
    };
  }, [positions]);

  // 3. Chronological Time-Series Chart Data (Cumulative Invested Cost & Cumulative Realized P&L)
  const timeSeriesData = useMemo(() => {
    const events = [];

    for (const t of transactions) {
      const dStr = t.Date || t.date || '';
      if (!dStr) continue;

      const parseDate = (s) => {
        const parts = s.split('/');
        if (parts.length === 3) return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
        return new Date(s);
      };
      const dObj = parseDate(dStr);
      if (isNaN(dObj.getTime())) continue;

      // MF Parse
      const mf = parseMutualFundTransaction(t);
      if (mf && (mf.action === 'BUY' || mf.action === 'SELL')) {
        events.push({
          dateObj: dObj,
          dateLabel: dStr,
          costDelta: mf.action === 'BUY' ? mf.costBasis : -mf.costBasis,
          pnlDelta: mf.action === 'SELL' ? mf.realizedPnl : 0
        });
        continue;
      }

      // Share Market Parse
      const sm = parseTxnFields(t);
      if (sm && (sm.type === 'BUY' || sm.type === 'SELL')) {
        events.push({
          dateObj: dObj,
          dateLabel: dStr,
          costDelta: sm.type === 'BUY' ? (sm.costBasis || sm.cost) : -(sm.costBasis || sm.cost),
          pnlDelta: sm.type === 'SELL' ? (sm.realizedPnL || 0) : 0
        });
      }
    }

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
  }, [transactions]);

  return (
    <div className="portfolio-card performance-card">
      <div className="portfolio-card-header flex-between">
        <div>
          <h4 className="portfolio-card-title">Investment & Realized P&L</h4>
          <div className="portfolio-card-sub">
            Capital invested and realized gains/losses over time
          </div>
          <div className="portfolio-chart-helper-note" style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 4 }}>
            Historical capital deployed and realized gains/losses. Market value is not represented in this chart.
          </div>
        </div>
      </div>

      {/* Analytics Hero Strip */}
      <div className="performance-metrics-strip">
        <div className="perf-metric-box">
          <div className="perf-metric-lbl">Total Realized Gains / Losses</div>
          <div className={`perf-metric-val ${realizedBreakdown.totalRealized >= 0 ? 'pos' : 'neg'}`}>
            {realizedBreakdown.totalRealized >= 0 ? '+' : ''}{formatINR(realizedBreakdown.totalRealized)}
          </div>
          <div className="perf-metric-sub">Across all redeemed positions</div>
        </div>
        <div className="perf-metric-box">
          <div className="perf-metric-lbl">Best Realized Investment</div>
          <div className="perf-metric-val pos">
            {performers.topRedeemed[0] ? `${performers.topRedeemed[0].note || performers.topRedeemed[0].security} (+${formatINR(performers.topRedeemed[0].realizedPnl)})` : '—'}
          </div>
          <div className="perf-metric-sub">Highest individual realized gain among redeemed positions</div>
        </div>
      </div>

      {/* Historical Growth Chart */}
      <div className="performance-chart-container" style={{ width: '100%', height: 230, marginTop: 16 }}>
        <div className="chart-legend-row" style={{ display: 'flex', gap: 16, marginBottom: 8, fontSize: '0.78rem' }}>
          <span style={{ color: '#4F46E5', fontWeight: 600 }}>■ Cumulative Invested Cost</span>
          <span style={{ color: '#10B981', fontWeight: 600 }}>■ Cumulative Realized P&L</span>
        </div>
        {timeSeriesData.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
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
            <div className="performance-empty-title">Historical Trajectory Unavailable</div>
          </div>
        )}
      </div>
    </div>
  );
}
