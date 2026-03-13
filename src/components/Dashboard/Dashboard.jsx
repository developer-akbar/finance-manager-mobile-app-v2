import React, { useMemo, useState } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { parseDate, formatINR, formatINRCompact, calcTotals, txnType, txnAmount } from '../../utils/format.js';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import './Dashboard.css';

const MONTHS     = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const now = new Date();

// ── Eye icon ─────────────────────────────────────────────────────────────────
const EyeIcon = ({ open }) => open
  ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
  : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>;

// ── Finance tip of the day ────────────────────────────────────────────────────
const TIPS = [
  { icon:'💡', text:'Pay yourself first — set aside savings before spending.' },
  { icon:'📊', text:'Track every expense for 30 days to spot patterns you never noticed.' },
  { icon:'🎯', text:'The 50/30/20 rule: 50% needs, 30% wants, 20% savings.' },
  { icon:'🏦', text:'Keep 3–6 months of expenses in an emergency fund.' },
  { icon:'📈', text:'SIP investments benefit most from time, not timing.' },
  { icon:'✂️', text:'Cancel subscriptions you haven\'t used in 30+ days.' },
  { icon:'🧾', text:'Use the envelope method: budget cash into labeled categories.' },
  { icon:'🔄', text:'Automate bill payments to avoid late fees.' },
  { icon:'💳', text:'Pay your full credit card bill monthly to avoid interest.' },
  { icon:'📉', text:'Inflation erodes idle cash — keep savings in instruments that beat it.' },
  { icon:'🥗', text:'Meal prepping can cut food expenses by 30–40% monthly.' },
  { icon:'🚗', text:'Compare insurance quotes every year — loyalty rarely pays.' },
];
const todayTip = TIPS[now.getDate() % TIPS.length];

export default function Dashboard() {
  const { state, navigate } = useApp();
  const { transactions, budgets, settings } = state;

  const [showNW, setShowNW] = useState(false); // privacy: hidden by default

  const hour     = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const name     = settings?.name || '';
  const monthLabel = now.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  // ── This-month txns ─────────────────────────────────────────────────────────
  const monthTxns = useMemo(() =>
    transactions.filter(t => {
      const d = parseDate(t.Date);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }),
    [transactions]);
  const totals = useMemo(() => calcTotals(monthTxns), [monthTxns]);

  // ── Net worth ───────────────────────────────────────────────────────────────
  const netWorth = useMemo(() => {
    let bal = 0;
    for (const t of transactions) {
      const tp = txnType(t), amt = txnAmount(t);
      if (tp === 'income')  bal += amt;
      if (tp === 'expense') bal -= amt;
    }
    return bal;
  }, [transactions]);

  // ── 6-month bar chart ───────────────────────────────────────────────────────
  const chartData = useMemo(() =>
    Array.from({ length: 6 }, (_, i) => {
      const d    = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1);
      const txns = transactions.filter(t => {
        const td = parseDate(t.Date);
        return td.getFullYear() === d.getFullYear() && td.getMonth() === d.getMonth();
      });
      const tot = calcTotals(txns);
      return { name: MONTHS[d.getMonth()], income: tot.income, expense: tot.expense };
    }),
    [transactions]);

  // ── Top 5 categories this month ─────────────────────────────────────────────
  const topCats = useMemo(() => {
    const map = {};
    for (const t of monthTxns.filter(t => txnType(t) === 'expense')) {
      const c = t.Category || 'Others';
      map[c] = (map[c] || 0) + txnAmount(t);
    }
    return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [monthTxns]);

  // ── Analytics ───────────────────────────────────────────────────────────────
  const analytics = useMemo(() => {
    if (!transactions.length) return null;

    // Group by month key "YYYY-MM"
    const byMonth = {};
    for (const t of transactions) {
      if (txnType(t) !== 'expense') continue;
      const d   = parseDate(t.Date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      byMonth[key] = (byMonth[key] || 0) + txnAmount(t);
    }
    const monthKeys = Object.keys(byMonth).sort();
    if (!monthKeys.length) return null;

    const monthlyAmts  = monthKeys.map(k => byMonth[k]);
    const avgMonthly   = monthlyAmts.reduce((a, b) => a + b, 0) / monthlyAmts.length;

    // Group by year
    const byYear = {};
    for (const [k, v] of Object.entries(byMonth)) {
      const yr = k.split('-')[0];
      if (!byYear[yr]) byYear[yr] = { total: 0, months: [] };
      byYear[yr].total += v;
      byYear[yr].months.push(v);
    }
    const avgYearly = Object.values(byYear).reduce((s, y) => s + y.total, 0) / Object.keys(byYear).length;

    // Yearly table rows
    const yearRows = Object.entries(byYear)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 5)
      .map(([yr, data]) => ({
        year:    yr,
        total:   data.total,
        monthly: data.total / data.months.length,
      }));

    // Highest spending month ever
    const maxKey = monthKeys.reduce((a, b) => byMonth[a] > byMonth[b] ? a : b);
    const [maxY, maxM] = maxKey.split('-');
    const highestMonth = `${MONTHS_FULL[parseInt(maxM) - 1]} ${maxY}`;
    const highestAmt   = byMonth[maxKey];

    // Saving rate this month
    const savingRate = totals.income > 0
      ? Math.round(((totals.income - totals.expense) / totals.income) * 100)
      : null;

    return { avgMonthly, avgYearly, yearRows, highestMonth, highestAmt, savingRate };
  }, [transactions, totals]);

  // ── Budget progress ─────────────────────────────────────────────────────────
  const budgetProgress = useMemo(() =>
    budgets.map(b => {
      const spend = monthTxns
        .filter(t => t.Category === b.category)
        .reduce((s, t) => s + (parseFloat(t.INR || t.Amount) || 0), 0);
      return { ...b, spend, pct: Math.min(100, b.amount > 0 ? (spend / b.amount) * 100 : 0) };
    }),
    [budgets, monthTxns]);

  return (
    <div className="dash-screen">

      {/* ── Greeting ── */}
      <div className="dash-greeting">
        <div className="dash-hello">{greeting}{name ? `, ${name}` : ' 👋'}</div>
      </div>

      {/* ── Net worth card ── */}
      <div className="dash-nw-card">
        <div className="dash-nw-top-row">
          <div>
            <div className="dash-nw-label">NET WORTH</div>
            <div className="dash-nw-month">{monthLabel}</div>
          </div>
          <button className="dash-eye-btn" onClick={() => setShowNW(v => !v)} aria-label="Toggle visibility">
            <EyeIcon open={showNW}/>
          </button>
        </div>
        <div className="dash-nw-value">
          {showNW ? formatINR(netWorth) : '₹ ••••••'}
        </div>
        <div className="dash-nw-row">
          <div className="dash-nw-item">
            <div className="dash-nw-item-l">↑ INCOME</div>
            <div className="dash-nw-item-v income">{showNW ? formatINRCompact(totals.income) : '••••'}</div>
          </div>
          <div className="dash-nw-item">
            <div className="dash-nw-item-l">↓ EXPENSE</div>
            <div className="dash-nw-item-v expense">{showNW ? formatINRCompact(totals.expense) : '••••'}</div>
          </div>
          <div className="dash-nw-item">
            <div className="dash-nw-item-l">= SAVED</div>
            <div className="dash-nw-item-v" style={{ color: totals.balance >= 0 ? 'var(--income)' : 'var(--expense)' }}>
              {showNW ? formatINRCompact(totals.balance) : '••••'}
            </div>
          </div>
        </div>
        {analytics?.savingRate !== null && analytics?.savingRate !== undefined && (
          <div className="dash-saving-rate">
            <div className="dash-sr-bar">
              <div className="dash-sr-fill" style={{ width: `${Math.max(0, analytics.savingRate)}%`, background: analytics.savingRate >= 20 ? 'var(--income)' : analytics.savingRate >= 0 ? 'var(--gold)' : 'var(--expense)' }}/>
            </div>
            <span className="dash-sr-label">Saving rate: {analytics.savingRate}% this month</span>
          </div>
        )}
      </div>

      {/* ── Quick nav ── */}
      <div className="dash-quick-nav">
        {[
          { id:'transactions', icon:'📋', label:'Transactions' },
          { id:'accounts',     icon:'💳', label:'Accounts' },
          { id:'categories',   icon:'🏷️', label:'Categories' },
          { id:'settings',     icon:'⚙️', label:'Settings' },
        ].map(it => (
          <button key={it.id} className="quick-nav-btn" onClick={() => navigate(it.id)}>
            <span className="quick-nav-icon">{it.icon}</span>
            <span className="quick-nav-label">{it.label}</span>
          </button>
        ))}
      </div>

      {/* ── Tip of the day ── */}
      <div className="dash-tip-card">
        <span className="dash-tip-icon">{todayTip.icon}</span>
        <span className="dash-tip-text">{todayTip.text}</span>
      </div>

      {/* ── 6-month overview chart ── */}
      <div className="dash-section-hdr"><span>6-Month Overview</span></div>
      <div style={{ padding: '0 var(--page-px) 10px' }}>
        <div className="dash-chart-card">
          <ResponsiveContainer width="100%" height={120}>
            <BarChart data={chartData} barSize={10}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false}/>
              <XAxis dataKey="name" tick={{ fontSize: 9, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false}/>
              <YAxis tick={{ fontSize: 9, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} tickFormatter={v => formatINRCompact(v)} width={36}/>
              <Tooltip formatter={v => formatINR(v)} contentStyle={{ background: 'var(--bg-card2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 11 }}/>
              <Bar dataKey="income"  fill="var(--income)"  radius={[3, 3, 0, 0]}/>
              <Bar dataKey="expense" fill="var(--expense)" radius={[3, 3, 0, 0]}/>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Analytics cards ── */}
      {analytics && (
        <>
          <div className="dash-section-hdr"><span>Spending Analytics</span></div>
          <div className="dash-analytics-row">
            <div className="dash-stat-card">
              <div className="dash-stat-icon">📅</div>
              <div className="dash-stat-label">Avg Monthly</div>
              <div className="dash-stat-value expense">{formatINRCompact(analytics.avgMonthly)}</div>
            </div>
            <div className="dash-stat-card">
              <div className="dash-stat-icon">📆</div>
              <div className="dash-stat-label">Avg Yearly</div>
              <div className="dash-stat-value expense">{formatINRCompact(analytics.avgYearly)}</div>
            </div>
            <div className="dash-stat-card">
              <div className="dash-stat-icon">🔥</div>
              <div className="dash-stat-label">Peak Month</div>
              <div className="dash-stat-value" style={{ fontSize: '0.72rem', color: 'var(--expense)', fontWeight: 800 }}>{analytics.highestMonth}</div>
            </div>
          </div>

          {/* Yearly table */}
          <div className="dash-section-hdr"><span>Yearly Analysis</span></div>
          <div style={{ padding: '0 var(--page-px) 10px' }}>
            <div className="dash-year-table">
              <div className="dash-year-header">
                <span>Year</span><span>Total Spent</span><span>Monthly Avg</span>
              </div>
              {analytics.yearRows.map(r => (
                <div key={r.year} className="dash-year-row">
                  <span className="dash-year-yr">{r.year}</span>
                  <span className="dash-year-total">{formatINRCompact(r.total)}</span>
                  <span className="dash-year-avg">{formatINRCompact(r.monthly)}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ── Top spending ── */}
      {topCats.length > 0 && (
        <>
          <div className="dash-section-hdr">
            <span>Top Spending This Month</span>
            <button className="dash-section-link" onClick={() => navigate('categories')}>Details</button>
          </div>
          <div style={{ padding: '0 var(--page-px)' }}>
            {topCats.map(([cat, amt], i) => {
              const maxAmt = topCats[0][1];
              const pct    = maxAmt > 0 ? (amt / maxAmt) * 100 : 0;
              return (
                <div key={cat} className="top-cat-row">
                  <span className="top-cat-rank">#{i + 1}</span>
                  <div className="top-cat-mid">
                    <div className="top-cat-name">{cat}</div>
                    <div className="progress-track" style={{ marginTop: 4 }}>
                      <div className="progress-fill" style={{ width: `${pct}%`, background: 'var(--expense)', opacity: 0.7 }}/>
                    </div>
                  </div>
                  <div className="top-cat-amt">{formatINR(amt)}</div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ── Budgets ── */}
      {budgetProgress.length > 0 && (
        <>
          <div className="dash-section-hdr">
            <span>Budgets</span>
            <button className="dash-section-link" onClick={() => navigate('settings')}>Manage</button>
          </div>
          <div style={{ padding: '0 var(--page-px)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {budgetProgress.map(b => (
              <div key={b.category} className="budget-detail-card">
                <div className="budget-detail-top">
                  <div className="budget-detail-name">{b.category}</div>
                  <div className="budget-detail-period">{b.period}</div>
                </div>
                <div className="budget-detail-vals">
                  <span style={{ color: b.pct > 85 ? 'var(--expense)' : 'var(--income)' }}>{formatINR(b.spend)}</span>
                  <span style={{ color: 'var(--text-muted)' }}> / {formatINR(b.amount)}</span>
                </div>
                <div className="progress-track" style={{ marginTop: 6 }}>
                  <div className="progress-fill" style={{ width: `${b.pct}%`, background: b.pct > 85 ? 'var(--expense)' : 'var(--green)' }}/>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div style={{ height: 80 }}/>
    </div>
  );
}
