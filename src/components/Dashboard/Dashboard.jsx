import React, { useMemo, useState, useEffect } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { parseDate, formatINR, formatINRCompact, calcTotals, txnType, txnAmount, isLifestyleExpense } from '../../utils/format.js';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { ccBalances, isCreditCard, ccDaysUntilDue, ccNextDueDate } from '../Accounts/Accounts.jsx';
import CashFlowForecast from '../Forecast/CashFlowForecast.jsx';
import { parseBankSMS } from '../../utils/smsParser.js';
import DebtTracker from '../Accounts/DebtTracker.jsx';
import CardOptimizer from '../Accounts/CardOptimizer.jsx';
import GroupSplitManager from '../Groups/GroupSplitManager.jsx';
import StockManager from '../Accounts/StockManager.jsx';
import AddTransaction from '../Transactions/AddTransaction.jsx';
import { calculateIncomeMilestones } from '../../utils/milestones.js';
import './Dashboard.css';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const now = new Date();

// ── Eye icon ─────────────────────────────────────────────────────────────────
const EyeIcon = ({ open }) => open
  ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
  : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>;

// ── Finance tip of the day ────────────────────────────────────────────────────
const TIPS = [
  { icon: '💡', text: 'Pay yourself first — set aside savings before spending.' },
  { icon: '📊', text: 'Track every expense for 30 days to spot patterns you never noticed.' },
  { icon: '🎯', text: 'The 50/30/20 rule: 50% needs, 30% wants, 20% savings.' },
  { icon: '🏦', text: 'Keep 3–6 months of expenses in an emergency fund.' },
  { icon: '📈', text: 'SIP investments benefit most from time, not timing.' },
  { icon: '✂️', text: 'Cancel subscriptions you haven\'t used in 30+ days.' },
  { icon: '🧾', text: 'Use the envelope method: budget cash into labeled categories.' },
  { icon: '🔄', text: 'Automate bill payments to avoid late fees.' },
  { icon: '💳', text: 'Pay your full credit card bill monthly to avoid interest.' },
  { icon: '📉', text: 'Inflation erodes idle cash — keep savings in instruments that beat it.' },
  { icon: '🥗', text: 'Meal prepping can cut food expenses by 30–40% monthly.' },
  { icon: '🚗', text: 'Compare insurance quotes every year — loyalty rarely pays.' },
];
const todayTip = TIPS[now.getDate() % TIPS.length];

export default function Dashboard({ onAddTransaction, backInterceptRef }) {
  const { state, navigate } = useApp();
  const { transactions, budgets, settings } = state;

  const [showNW, setShowNW] = useState(false); // privacy: hidden by default
  const [chartView, setChartView] = useState('networth'); // 'networth' or 'overview'
  const [popupMsg, setPopupMsg] = useState(''); // Custom detail sheet popup
  const [showAllYears, setShowAllYears] = useState(false);
  const [showForecast, setShowForecast] = useState(false);
  const [showMilestones, setShowMilestones] = useState(false);
  const [detectedSmsTxn, setDetectedSmsTxn] = useState(null);

  // Derive income milestones dynamically in O(N) single pass over ledger
  const incomeMilestones = useMemo(() => calculateIncomeMilestones(transactions), [transactions]);

  // Sub-screen navigation states
  const [showGroups, setShowGroups] = useState(false);
  const [showOptimizer, setShowOptimizer] = useState(false);
  const [showDebtTracker, setShowDebtTracker] = useState(false);
  const [showStockManager, setShowStockManager] = useState(false);
  const [settlePrefill, setSettlePrefill] = useState(null);

  // Sync back button intercepts dynamically
  useEffect(() => {
    if (!backInterceptRef) return;
    if (showMilestones) {
      backInterceptRef.current = () => setShowMilestones(false);
    } else if (showGroups) {
      backInterceptRef.current = () => setShowGroups(false);
    } else if (showOptimizer) {
      backInterceptRef.current = () => setShowOptimizer(false);
    } else if (showDebtTracker) {
      backInterceptRef.current = () => setShowDebtTracker(false);
    } else if (showStockManager) {
      backInterceptRef.current = () => setShowStockManager(false);
    } else if (showForecast) {
      backInterceptRef.current = () => setShowForecast(false);
    } else {
      backInterceptRef.current = null;
    }
    return () => {
      if (backInterceptRef) backInterceptRef.current = null;
    };
  }, [showMilestones, showGroups, showOptimizer, showDebtTracker, showStockManager, showForecast, backInterceptRef]);

  // Auto-detect SMS / UPI transaction copied to clipboard
  useEffect(() => {
    const checkClipboard = async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.readText) {
          const text = await navigator.clipboard.readText();
          if (text && text.length > 15 && text.length < 500) {
            const parsed = parseBankSMS(text, state.accounts || [], state.categories || {});
            if (parsed && parsed.amount) {
              const lastDismissed = sessionStorage.getItem('finman_dismissed_sms');
              if (lastDismissed !== text) {
                setDetectedSmsTxn({ ...parsed, rawText: text });
              }
            }
          }
        }
      } catch { /* clipboard read blocked or empty */ }
    };
    checkClipboard();
    window.addEventListener('focus', checkClipboard);
    return () => window.removeEventListener('focus', checkClipboard);
  }, [state.accounts, state.categories]);

  // Handle Home tab tap to reset sub-views
  useEffect(() => {
    const handleReset = () => {
      setShowMilestones(false);
      setShowForecast(false);
      setShowAllYears(false);
      setPopupMsg('');
    };
    window.addEventListener('reset-dashboard-view', handleReset);
    return () => window.removeEventListener('reset-dashboard-view', handleReset);
  }, []);

  // Handle keyboard Escape for milestones modal
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' || e.key === 'Esc') {
        if (showMilestones) {
          setShowMilestones(false);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showMilestones]);

  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const name = settings?.name || '';
  const monthLabel = now.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  // ── Investment keywords & checker ──
  const INVESTMENT_KEYWORDS = ['stock', 'mutual fund', 'ppf', 'ssy', 'equity', 'share market', 'investment', 'recurring deposit'];
  const isInvestment = (name) => {
    const n = String(name || '').toLowerCase();
    // Match 'rd' only as a full word to avoid matching 'card'
    const hasWordRD = /\brd\b/i.test(n);
    return INVESTMENT_KEYWORDS.some(kw => n.includes(kw)) || hasWordRD;
  };

  // ── Balance calculation map ──
  const acctBalances = useMemo(() => {
    const map = {};
    const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(String(s).trim());
    const ensure = n => { if (n && !looksNumeric(n) && !map[n]) map[n] = 0; };
    const addTo = (n, v) => { if (n && !looksNumeric(n)) { ensure(n); map[n] = (map[n] || 0) + v; } };

    for (const t of transactions) {
      const amt = txnAmount(t);
      const type = String(t['Income/Expense'] || '').trim();
      const acct = String(t.Account || '').trim();
      const fromAcct = String(t.FromAccount || t.Account || '').trim();
      const dest = String(t.ToAccount || '').trim();

      if (type === 'Income') {
        addTo(dest || acct, +amt);
      } else if (type === 'Expense') {
        addTo(fromAcct || acct, -amt);
      } else if (type === 'Transfer-Out') {
        addTo(fromAcct, -amt);
        addTo(dest, +amt);
      }
    }
    return map;
  }, [transactions]);

  const netWorth = useMemo(() => Object.values(acctBalances).reduce((s, v) => s + v, 0), [acctBalances]);
  const assets = useMemo(() => {
    const acctList = state.accounts || [];
    return Object.entries(acctBalances).reduce((sum, [name, val]) => {
      const a = acctList.find(acc => (acc.name || acc) === name);
      const isAsset = a?.isAsset !== undefined ? a.isAsset : !['credit card', 'credit', 'loan', 'emi', 'borrow', 'pay later', 'installments'].some(k => name.toLowerCase().includes(k));
      if (isAsset && val > 0) return sum + val;
      return sum;
    }, 0);
  }, [acctBalances, state.accounts]);

  const liabilities = useMemo(() => {
    const acctList = state.accounts || [];
    return Object.entries(acctBalances).reduce((sum, [name, val]) => {
      const a = acctList.find(acc => (acc.name || acc) === name);
      const isAsset = a?.isAsset !== undefined ? a.isAsset : !['credit card', 'credit', 'loan', 'emi', 'borrow', 'pay later', 'installments'].some(k => name.toLowerCase().includes(k));
      if (!isAsset) return sum + Math.abs(val);
      if (isAsset && val < 0) return sum + Math.abs(val); // overdraft
      return sum;
    }, 0);
  }, [acctBalances, state.accounts]);

  // ── This-month txns ─────────────────────────────────────────────────────────
  const monthTxns = useMemo(() =>
    transactions.filter(t => {
      const d = parseDate(t.Date);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }),
    [transactions]);
  const totals = useMemo(() => calcTotals(monthTxns), [monthTxns]);

  // ── Credit Card due reminders ──
  const dueAlerts = useMemo(() => {
    const today = new Date();
    const alerts = [];
    for (const a of (state.accounts || [])) {
      if (!isCreditCard(a) || !a.settlementDate || !a.paymentDueDays) continue;
      const days = ccDaysUntilDue(a, today);
      if (days === null) continue;
      if (days <= 7) {
        const { balancePayable } = ccBalances(transactions, a.name, a.settlementDate, today);
        if (balancePayable > 0) {
          alerts.push({ acct: a, days, due: ccNextDueDate(a, today), balancePayable });
        }
      }
    }
    return alerts;
  }, [state.accounts, transactions]);

  // ── Investment calculations ──
  const investmentStats = useMemo(() => {
    let monthlyInvested = 0;
    let totalInvested = 0;

    for (const t of transactions) {
      const amt = txnAmount(t);
      const type = String(t['Income/Expense'] || 'Expense').trim();
      const acct = String(t.Account || t.FromAccount || '').trim();
      const dest = String(t.ToAccount || '').trim();
      const cat = String(t.Category || '').trim();
      const isXfer = type.toLowerCase().startsWith('transfer');

      const isInv = isInvestment(cat) || (isXfer && isInvestment(dest)) || isInvestment(acct);
      if (isInv) {
        totalInvested += amt;
        const d = parseDate(t.Date);
        if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) {
          monthlyInvested += amt;
        }
      }
    }
    return { monthlyInvested, totalInvested };
  }, [transactions]);

  // ── Emergency Runway ──
  const runwayStats = useMemo(() => {
    let liquidAssets = 0;
    for (const [name, balance] of Object.entries(acctBalances)) {
      if (balance > 0 && !isInvestment(name)) {
        liquidAssets += balance;
      }
    }

    const threeMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const recentTxns = transactions.filter(t => {
      const d = parseDate(t.Date);
      return d >= threeMonthsAgo && txnType(t) === 'expense' && !isInvestment(t.Category);
    });

    const totalExpenseLast3m = recentTxns.reduce((sum, t) => sum + txnAmount(t), 0);
    const avgMonthlyExpense = totalExpenseLast3m / 3 || 1;
    const runwayMonths = liquidAssets / avgMonthlyExpense;
    return { liquidAssets, avgMonthlyExpense, runwayMonths };
  }, [acctBalances, transactions]);

  // ── Spend changes MoM ──
  const momStats = useMemo(() => {
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

    let thisMonthSpend = 0;
    let lastMonthSpend = 0;

    for (const t of transactions) {
      if (txnType(t) !== 'expense' || isInvestment(t.Category)) continue;
      const d = parseDate(t.Date);
      if (d >= thisMonthStart) {
        thisMonthSpend += txnAmount(t);
      } else if (d >= lastMonthStart && d <= lastMonthEnd) {
        lastMonthSpend += txnAmount(t);
      }
    }

    const pctChange = lastMonthSpend > 0 ? ((thisMonthSpend - lastMonthSpend) / lastMonthSpend) * 100 : 0;
    return { thisMonthSpend, lastMonthSpend, pctChange };
  }, [transactions]);

  // ── 6-month Net Worth History Chart ──
  const netWorthHistory = useMemo(() => {
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({
        year: d.getFullYear(),
        month: d.getMonth(),
        label: MONTHS[d.getMonth()],
      });
    }

    return months.map(m => {
      const endOfMonth = new Date(m.year, m.month + 1, 0, 23, 59, 59, 999);
      let nwAtEnd = 0;
      let inc = 0;
      let exp = 0;

      for (const t of transactions) {
        const d = parseDate(t.Date);
        if (d <= endOfMonth) {
          const tp = txnType(t), amt = txnAmount(t);
          if (tp === 'income') nwAtEnd += amt;
          if (tp === 'expense') nwAtEnd -= amt;
        }
        if (d.getFullYear() === m.year && d.getMonth() === m.month) {
          const tp = txnType(t), amt = txnAmount(t);
          if (tp === 'income') inc += amt;
          if (tp === 'expense') exp += amt;
        }
      }

      return {
        name: m.label,
        'Net Worth': Math.round(nwAtEnd),
        'income': Math.round(inc),
        'expense': Math.round(exp)
      };
    });
  }, [transactions]);

  // ── 6-month Overview (BarChart) ──
  const chartData = useMemo(() =>
    netWorthHistory.map(h => ({
      name: h.name,
      income: h.income,
      expense: h.expense
    })), [netWorthHistory]);

  // ── Top 5 categories this month ─────────────────────────────────────────────
  const topCats = useMemo(() => {
    const map = {};
    for (const t of monthTxns.filter(isLifestyleExpense)) {
      const c = t.Category || 'Others';
      map[c] = (map[c] || 0) + txnAmount(t);
    }
    return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [monthTxns]);

  // ── Budget progress ─────────────────────────────────────────────────────────
  const budgetProgress = useMemo(() =>
    budgets.map(b => {
      const spend = monthTxns
        .filter(t => t.Category === b.category)
        .reduce((s, t) => s + (parseFloat(t.INR || t.Amount) || 0), 0);
      return { ...b, spend, pct: Math.min(100, b.amount > 0 ? (spend / b.amount) * 100 : 0) };
    }),
    [budgets, monthTxns]);

  // Saving rate
  const savingRate = useMemo(() => {
    if (totals.income === 0) return 0;
    return Math.round(((totals.income - totals.expense) / totals.income) * 100);
  }, [totals]);

  // ── Analytics calculations ──
  const analytics = useMemo(() => {
    if (!transactions.length) return null;

    const byMonth = {};
    for (const t of transactions) {
      if (txnType(t) !== 'expense' || isInvestment(t.Category)) continue;
      const d = parseDate(t.Date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      byMonth[key] = (byMonth[key] || 0) + txnAmount(t);
    }
    const monthKeys = Object.keys(byMonth).sort();
    if (!monthKeys.length) return null;

    let totalExpense = 0;
    let highestMonth = '';
    let highestAmt = 0;
    for (const [k, v] of Object.entries(byMonth)) {
      totalExpense += v;
      if (v > highestAmt) {
        highestAmt = v;
        highestMonth = k;
      }
    }
    const avgMonthly = totalExpense / monthKeys.length;

    let peakMonthDisplay = 'N/A';
    if (highestMonth) {
      const [yr, mo] = highestMonth.split('-');
      const mName = MONTHS_FULL[parseInt(mo, 10) - 1];
      peakMonthDisplay = `${mName} ${yr}`;
    }

    const byYear = {};
    for (const [k, v] of Object.entries(byMonth)) {
      const yr = k.split('-')[0];
      byYear[yr] = (byYear[yr] || 0) + v;
    }

    const yearKeys = Object.keys(byYear).sort();
    let totalYearlyExpense = 0;
    let peakYear = '';
    let peakYearAmt = 0;
    for (const [yr, v] of Object.entries(byYear)) {
      totalYearlyExpense += v;
      if (v > peakYearAmt) {
        peakYearAmt = v;
        peakYear = yr;
      }
    }
    const avgYearly = yearKeys.length > 0 ? totalYearlyExpense / yearKeys.length : 0;

    const yearRows = yearKeys.map(yr => {
      const mKeys = monthKeys.filter(k => k.startsWith(yr));
      const total = byYear[yr];
      const monthly = mKeys.length > 0 ? total / mKeys.length : 0;
      return { year: yr, total, monthly };
    }).reverse();

    return {
      avgMonthly,
      avgYearly,
      highestMonth: peakMonthDisplay,
      highestAmt,
      peakYear,
      peakYearAmt,
      yearRows
    };
  }, [transactions]);

  if (showForecast) {
    return <CashFlowForecast onBack={() => setShowForecast(false)} backInterceptRef={backInterceptRef} />;
  }

  if (showGroups) {
    return <GroupSplitManager onBack={() => setShowGroups(false)} backInterceptRef={backInterceptRef} />;
  }

  if (showOptimizer) {
    return <CardOptimizer onBack={() => setShowOptimizer(false)} backInterceptRef={backInterceptRef} />;
  }

  if (showDebtTracker) {
    return (
      <>
        <DebtTracker
          onBack={() => setShowDebtTracker(false)}
          backInterceptRef={backInterceptRef}
          onSettle={({ name, amount, type }) => {
            const firstSavings = (state.accounts || []).find(a => !['credit card', 'credit', 'lend', 'borrow'].some(k => (a.name || a).toLowerCase().includes(k))) || 'Cash';
            const bankName = typeof firstSavings === 'object' ? firstSavings.name : firstSavings;
            setSettlePrefill({
              type: 'Transfer-Out',
              fromAccount: type === 'receive' ? 'Lend' : bankName,
              toAccount: type === 'receive' ? '' : 'Borrow',
              amount: String(amount),
              note: type === 'receive' ? `From ${name}` : `To ${name}`,
            });
          }}
        />
        {settlePrefill && (
          <AddTransaction
            prefillType={settlePrefill.type}
            prefillFromAccount={settlePrefill.fromAccount}
            prefillToAccount={settlePrefill.toAccount}
            prefillAmount={settlePrefill.amount}
            prefillNote={settlePrefill.note}
            onClose={() => setSettlePrefill(null)}
            onSaveAndContinue={() => setSettlePrefill(null)}
            backInterceptRef={backInterceptRef}
          />
        )}
      </>
    );
  }

  if (showStockManager) {
    return <StockManager onBack={() => setShowStockManager(false)} backInterceptRef={backInterceptRef} />;
  }

  return (
    <div className="dash-screen">
      {/* ── Greeting & Actions (Full width theme header) ── */}
      <div className="dash-greeting" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="dash-hello">{greeting}{name ? `, ${name}` : ' 👋'}</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button
            type="button"
            className="dash-milestones-btn"
            onClick={() => setShowMilestones(true)}
            title="Financial Milestones & Achievements"
            aria-label="Financial Milestones"
            style={{
              padding: '6px 9px',
              borderRadius: 14,
              fontSize: '0.78rem',
              fontWeight: 700,
              border: '1px solid var(--border)',
              background: 'var(--theme-header-btn-bg, var(--bg-card2))',
              color: 'var(--theme-header-btn-color, var(--text-primary))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              position: 'relative',
            }}
          >
            <span style={{ fontSize: '0.95rem', lineHeight: 1 }}>🏆</span>
            {incomeMilestones.achievedCount > 0 && (
              <span className="dash-milestones-badge" style={{
                position: 'absolute',
                top: -3,
                right: -3,
                minWidth: 14,
                height: 14,
                borderRadius: 7,
                background: 'var(--income)',
                color: '#0a0f1e',
                fontSize: '0.55rem',
                fontWeight: 900,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 3px',
                lineHeight: 1,
                border: '1.5px solid var(--theme-header-bg, var(--bg-base))'
              }}>
                {incomeMilestones.achievedCount}
              </span>
            )}
          </button>
          <button
            onClick={() => navigate('analytics')}
            style={{
              padding: '6px 10px',
              borderRadius: 14,
              fontSize: '0.74rem',
              fontWeight: 700,
              border: '1px solid var(--border)',
              background: 'var(--theme-header-btn-bg, var(--bg-card2))',
              color: 'var(--theme-header-btn-color, var(--text-primary))',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              cursor: 'pointer',
            }}
          >
            <span>📊</span> Analytics
          </button>
          <button
            onClick={() => setShowForecast(true)}
            style={{
              padding: '6px 10px',
              borderRadius: 14,
              fontSize: '0.74rem',
              fontWeight: 700,
              border: '1px solid var(--border)',
              background: 'var(--theme-header-btn-bg, var(--bg-card2))',
              color: 'var(--theme-header-btn-color, var(--text-primary))',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              cursor: 'pointer',
            }}
          >
            <span>📈</span> Cash Flow
          </button>
        </div>
      </div>

      <div className="dash-scrollable-content">
        <div className="app-container">

        {/* ── SMS / UPI Clipboard Detection Banner ── */}
        {detectedSmsTxn && (
          <div style={{
            margin: '10px var(--page-px) 0',
            padding: '10px 14px',
            background: 'linear-gradient(135deg, rgba(0,229,160,0.16), rgba(77,159,255,0.12))',
            border: '1px solid var(--accent)',
            borderRadius: 14,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '0.7rem', fontWeight: 800, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 4 }}>
                ⚡ SMS / UPI Alert Detected
              </div>
              <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                ₹{detectedSmsTxn.amount} ({detectedSmsTxn.type}) {detectedSmsTxn.note ? `· ${detectedSmsTxn.note}` : ''}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
              <button
                className="btn btn-primary"
                style={{ padding: '5px 12px', fontSize: '0.72rem', fontWeight: 700, borderRadius: 10 }}
                onClick={() => {
                  onAddTransaction?.({
                    prefillAmount: detectedSmsTxn.amount,
                    prefillType: detectedSmsTxn.type,
                    prefillAccount: detectedSmsTxn.account,
                    prefillCategory: detectedSmsTxn.category,
                    prefillNote: detectedSmsTxn.note,
                    prefillDate: detectedSmsTxn.date,
                    prefillTime: detectedSmsTxn.time,
                  });
                  sessionStorage.setItem('finman_dismissed_sms', detectedSmsTxn.rawText);
                  setDetectedSmsTxn(null);
                }}
              >
                + Record
              </button>
              <button
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.85rem', padding: '4px 6px', cursor: 'pointer' }}
                onClick={() => {
                  sessionStorage.setItem('finman_dismissed_sms', detectedSmsTxn.rawText);
                  setDetectedSmsTxn(null);
                }}
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {/* ── Credit Card Due Alerts Banner ── */}
        {dueAlerts.length > 0 && (
          <div className="dash-alerts-container">
            {dueAlerts.map(alert => (
              <div key={alert.acct.name} className="dash-alert-banner" onClick={() => navigate('accounts')}>
                <span className="dash-alert-icon">💳</span>
                <div className="dash-alert-body">
                  <div className="dash-alert-title">{alert.acct.name} due in {alert.days}d</div>
                  <div className="dash-alert-subtitle">₹{alert.balancePayable.toLocaleString('en-IN')} payable · due {alert.due.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</div>
                </div>
                <span className="dash-alert-arrow">→</span>
              </div>
            ))}
          </div>
        )}

        {/* ── Top Hero Area (Net Worth + Contextual Financial Snapshot) ── */}
        <div className="dash-desktop-hero-grid">
          {/* Net worth card */}
          <div className="dash-nw-card">
            <div className="dash-nw-top-row">
              <div>
                <div className="dash-nw-label">NET WORTH</div>
                <div className="dash-nw-month">{monthLabel}</div>
              </div>
              <button className="dash-eye-btn" onClick={() => setShowNW(v => !v)} aria-label="Toggle visibility">
                <EyeIcon open={showNW} />
              </button>
            </div>
            <div className="dash-nw-value">
              {showNW ? formatINR(netWorth) : '₹ ••••••'}
            </div>
            <div className="dash-nw-row">
              <div className="dash-nw-item">
                <div className="dash-nw-item-l">Assets</div>
                <div className="dash-nw-item-v income">{showNW ? formatINRCompact(assets) : '••••'}</div>
              </div>
              <div className="dash-nw-item">
                <div className="dash-nw-item-l">Liabilities</div>
                <div className="dash-nw-item-v expense">{showNW ? formatINRCompact(liabilities) : '••••'}</div>
              </div>
              <div className="dash-nw-item">
                <div className="dash-nw-item-l">Saved this month</div>
                <div className="dash-nw-item-v" style={{ color: totals.balance >= 0 ? 'var(--income)' : 'var(--expense)' }}>
                  {showNW ? formatINRCompact(totals.balance) : '••••'}
                </div>
              </div>
            </div>
            {savingRate !== null && (
              <div className="dash-saving-rate">
                <div className="dash-sr-bar">
                  <div className="dash-sr-fill" style={{
                    width: `${Math.min(100, Math.max(0, savingRate))}%`,
                    background: savingRate >= 20 ? 'var(--income)' : savingRate >= 0 ? '#f0a500' : 'var(--expense)'
                  }} />
                </div>
                <span className="dash-sr-label">
                  Monthly Savings Rate: {savingRate >= 0 ? '' : '−'}{Math.abs(savingRate)}%
                </span>
              </div>
            )}
          </div>

          {/* Desktop Financial Context & Quick Actions Card */}
          <div className="dash-snapshot-card">
            <div className="dash-snapshot-metrics">
              <div className="dash-snap-metric">
                <div className="dash-snap-label">Emergency Runway</div>
                <div className="dash-snap-val">{runwayStats.runwayMonths >= 99 ? '> 5 yrs' : `${runwayStats.runwayMonths.toFixed(1)} mos`}</div>
                <div className="dash-snap-sub">{formatINRCompact(runwayStats.liquidAssets)} liquid cash</div>
              </div>
              <div className="dash-snap-metric">
                <div className="dash-snap-label">Invested This Month</div>
                <div className="dash-snap-val" style={{ color: '#818cf8' }}>{formatINRCompact(investmentStats.monthlyInvested)}</div>
                <div className="dash-snap-sub">{formatINRCompact(investmentStats.totalInvested)} all-time</div>
              </div>
              <div className="dash-snap-metric">
                <div className="dash-snap-label">MoM Expense Pace</div>
                <div className="dash-snap-val" style={{ color: momStats.pctChange <= 0 ? 'var(--income)' : 'var(--expense)' }}>
                  {momStats.pctChange >= 0 ? '+' : ''}{Math.round(momStats.pctChange)}%
                </div>
                <div className="dash-snap-sub">{formatINRCompact(momStats.thisMonthSpend)} spent</div>
              </div>
            </div>

            {/* Quick shortcuts */}
            <div className="home-features-grid">
              {[
                { id: 'analytics', label: 'Analytics', icon: '📊', onClick: () => navigate('analytics') },
                { id: 'forecast', label: 'Cashflow', icon: '🔮', onClick: () => setShowForecast(true) },
                { id: 'groups', label: 'Groups', icon: '👥', onClick: () => setShowGroups(true) },
                { id: 'perks', label: 'Card Perks', icon: '💳', onClick: () => setShowOptimizer(true) },
                { id: 'debt', label: 'Debt Tracker', icon: '🤝', onClick: () => setShowDebtTracker(true) },
                { id: 'stock', label: 'Stock Inventory', icon: '🥫', onClick: () => setShowStockManager(true) },
              ].map(item => (
                <button
                  key={item.id}
                  onClick={item.onClick}
                  className="home-feature-card"
                >
                  <span className="hf-icon">{item.icon}</span>
                  <span className="hf-label">{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── Mobile Quick Actions Grid (< 1024px) ── */}
        <div className="dash-mobile-shortcuts">
          {[
            { id: 'analytics', label: 'Analytics', icon: '📊', onClick: () => navigate('analytics') },
            { id: 'forecast', label: 'Cash Flow', icon: '📈', onClick: () => setShowForecast(true) },
            { id: 'groups', label: 'Groups', icon: '👥', onClick: () => setShowGroups(true) },
            { id: 'perks', label: 'Card Perks', icon: '💳', onClick: () => setShowOptimizer(true) },
            { id: 'debt', label: 'Debt Tracker', icon: '🤝', onClick: () => setShowDebtTracker(true) },
            { id: 'stock', label: 'Stock Inventory', icon: '📈', onClick: () => setShowStockManager(true) },
          ].map(item => (
            <button
              key={item.id}
              onClick={item.onClick}
              className="dash-mobile-shortcut-btn"
            >
              <span className="dash-mobile-shortcut-icon">{item.icon}</span>
              <span className="dash-mobile-shortcut-label">{item.label}</span>
            </button>
          ))}
        </div>

        {/* ── Tip of the day ── */}
        <div className="dash-tip-card">
          <span className="dash-tip-icon">{todayTip.icon}</span>
          <span className="dash-tip-text">{todayTip.text}</span>
        </div>

        {/* ── Main Analytical Workspace (2-Column Side-by-Side on Desktop) ── */}
        <div className="dash-main-workspace-grid">
          {/* Left Column: Trend/Overview Chart + Spending Analytics */}
          <div className="dash-ws-col">
            <div className="dash-section-hdr">
              <span>{chartView === 'networth' ? 'Net Worth Trend' : '6-Month Overview'}</span>
              <div className="dash-chart-toggle">
                <button className={`chart-toggle-btn ${chartView === 'networth' ? 'active' : ''}`} onClick={() => setChartView('networth')}>Trend</button>
                <button className={`chart-toggle-btn ${chartView === 'overview' ? 'active' : ''}`} onClick={() => setChartView('overview')}>Overview</button>
              </div>
            </div>
            <div className="dash-chart-card">
              {chartView === 'networth' ? (
                <ResponsiveContainer width="100%" height={175}>
                  <AreaChart data={netWorthHistory}>
                    <defs>
                      <linearGradient id="colorNW" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--green)" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="var(--green)" stopOpacity={0.0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 9, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 9, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} tickFormatter={v => formatINRCompact(v)} width={38} />
                    <Tooltip formatter={v => formatINR(v)} contentStyle={{ background: 'var(--bg-card2)', border: '1px solid var(--border)', borderRadius: 12, fontSize: 11 }} />
                    <Area type="monotone" dataKey="Net Worth" stroke="var(--green)" strokeWidth={2.5} fillOpacity={1} fill="url(#colorNW)" activeDot={{ r: 6 }} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <ResponsiveContainer width="100%" height={175}>
                  <BarChart data={chartData} barSize={12}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 9, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 9, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} tickFormatter={v => formatINRCompact(v)} width={38} />
                    <Tooltip formatter={v => formatINR(v)} contentStyle={{ background: 'var(--bg-card2)', border: '1px solid var(--border)', borderRadius: 12, fontSize: 11 }} />
                    <Bar dataKey="income" fill="var(--income)" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="expense" fill="var(--expense)" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            {analytics && (
              <>
                <div className="dash-section-hdr" style={{ marginTop: 14 }}><span>Spending Analytics</span></div>
                <div className="dash-analytics-grid">
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
                  <div className="dash-stat-card clickable" onClick={() => setPopupMsg(`Peak Month Spending:\nYou have spent ${formatINR(analytics.highestAmt)} in ${analytics.highestMonth}.`)}>
                    <div className="dash-stat-icon">🔥</div>
                    <div className="dash-stat-label">Peak Month</div>
                    <div className="dash-stat-value expense" style={{ fontSize: '0.72rem', fontWeight: 800 }}>
                      {analytics.highestMonth}
                    </div>
                  </div>
                  <div className="dash-stat-card clickable" onClick={() => setPopupMsg(`Peak Year Spending:\nYou have spent ${formatINR(analytics.peakYearAmt)} in the year ${analytics.peakYear}.`)}>
                    <div className="dash-stat-icon">👑</div>
                    <div className="dash-stat-label">Peak Year</div>
                    <div className="dash-stat-value expense" style={{ fontSize: '0.72rem', fontWeight: 800 }}>
                      Year {analytics.peakYear}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Right Column: Top Spending + Yearly Analysis / Budgets */}
          <div className="dash-ws-col">
            {topCats.length > 0 && (
              <>
                <div className="dash-section-hdr">
                  <span>Top Spending This Month</span>
                  <button className="dash-section-link" onClick={() => navigate('categories', { type: 'Expense', period: 'Month', year: now.getFullYear(), month: now.getMonth() })}>Details</button>
                </div>
                <div className="dash-year-table" style={{ padding: '4px var(--page-px)' }}>
                  {topCats.map(([cat, amt], i) => {
                    const maxAmt = topCats[0][1];
                    const pct = maxAmt > 0 ? (amt / maxAmt) * 100 : 0;
                    return (
                      <div key={cat} className="top-cat-row">
                        <span className="top-cat-rank">#{i + 1}</span>
                        <div className="top-cat-mid">
                          <div className="top-cat-name">{cat}</div>
                          <div className="progress-track" style={{ marginTop: 4 }}>
                            <div className="progress-fill" style={{ width: `${pct}%`, background: 'var(--expense)', opacity: 0.8 }} />
                          </div>
                        </div>
                        <div className="top-cat-amt">{formatINR(amt)}</div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {analytics && (
              <>
                <div className="dash-section-hdr" style={{ marginTop: 14 }}><span>Yearly Analysis</span></div>
                <div className="dash-year-table">
                  <div className="dash-year-header">
                    <span>Year</span><span>Total Spent</span><span>Monthly Avg</span>
                  </div>
                  {(showAllYears ? analytics.yearRows : analytics.yearRows.slice(0, 5)).map(r => (
                    <div key={r.year} className="dash-year-row clickable" onClick={() => navigate('transactions', { year: r.year })}>
                      <span className="dash-year-yr">{r.year}</span>
                      <span className="dash-year-total">{formatINRCompact(r.total)}</span>
                      <span className="dash-year-avg">{formatINRCompact(r.monthly)}</span>
                    </div>
                  ))}
                </div>
                {analytics.yearRows.length > 5 && (
                  <div style={{ textAlign: 'center', marginTop: 8 }}>
                    <button className="dash-section-link" style={{ textTransform: 'none' }} onClick={() => setShowAllYears(v => !v)}>
                      {showAllYears ? 'Show Less' : `Show More (${analytics.yearRows.length - 5} more)`}
                    </button>
                  </div>
                )}
              </>
            )}

            {budgetProgress.length > 0 && (
              <>
                <div className="dash-section-hdr" style={{ marginTop: 14 }}>
                  <span>Budgets</span>
                  <button className="dash-section-link" onClick={() => navigate('settings')}>Manage</button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
                        <div className="progress-fill" style={{ width: `${b.pct}%`, background: b.pct > 85 ? 'var(--expense)' : 'var(--green)' }} />
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── Financial Milestones & Achievements Modal / Sheet ── */}
        {showMilestones && (
          <FinancialMilestonesModal
            incomeMilestones={incomeMilestones}
            onClose={() => setShowMilestones(false)}
          />
        )}

        {/* ── Custom bottom sheet/popup overlay for detail message dialogs ── */}
        {popupMsg && (
          <>
            <div className="dash-popup-overlay" onClick={() => setPopupMsg('')} />
            <div className="dash-popup-sheet">
              <div className="dash-popup-sheet-handle" />
              <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>📊</div>
              <div className="dash-popup-text-body">
                {popupMsg.split('\n').map((line, idx) => (
                  <div key={idx} style={idx === 0 ? { fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 800, letterSpacing: '0.8px', marginBottom: 6 } : { fontSize: '1rem', color: 'var(--text-primary)', fontWeight: 700 }}>
                    {line}
                  </div>
                ))}
              </div>
              <button className="dash-popup-btn" onClick={() => setPopupMsg('')}>Got it</button>
            </div>
          </>
        )}

        </div> {/* End app-container */}
      </div> {/* End dash-scrollable-content */}

      {/* Floating FAB on Dashboard screen */}
      {onAddTransaction && (
        <button className="trans-fab" onClick={onAddTransaction} aria-label="Add transaction">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" width="22" height="22">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      )}
    </div>
  );
}

// ── Financial Milestones & Achievements Modal Component ────────────────────────
function FinancialMilestonesModal({ incomeMilestones, onClose }) {
  const { milestones, totalIncome, achievedCount, totalCount } = incomeMilestones;
  const pct = totalCount > 0 ? Math.round((achievedCount / totalCount) * 100) : 0;

  return (
    <div className="milestones-modal-wrap">
      <div className="overlay" onClick={onClose} />
      <div className="milestones-modal-card">
        <div className="sheet-handle mobile-only-sheet-handle" style={{ marginTop: 10 }} />
        <div className="milestones-modal-hdr">
          <div className="milestones-hdr-left">
            <span className="milestones-hdr-icon">🏆</span>
            <div>
              <div className="milestones-hdr-title">Financial Milestones</div>
              <div className="milestones-hdr-sub">{achievedCount} of {totalCount} Achieved · {pct}% Unlocked</div>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ fontSize: '1.1rem', padding: '4px 8px', lineHeight: 1 }}
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="milestones-summary-box">
          <div className="milestones-summary-row">
            <span className="milestones-summary-label">Total Cumulative Income</span>
            <span className="milestones-summary-val">{formatINR(totalIncome)}</span>
          </div>
          <div className="progress-track" style={{ height: 6, borderRadius: 3, marginTop: 4 }}>
            <div
              className="progress-fill"
              style={{
                width: `${pct}%`,
                background: 'linear-gradient(90deg, var(--green), #4d9fff)',
                borderRadius: 3,
              }}
            />
          </div>
        </div>

        <div className="milestones-list-scroll">
          {milestones.map(m => (
            <div key={m.id} className={`milestone-row ${m.achieved ? 'achieved' : 'locked'}`}>
              <div className="milestone-status-badge">
                {m.achieved ? '🏆' : '🔒'}
              </div>
              <div className="milestone-content">
                <div className="milestone-top-line">
                  <span className="milestone-tag">{m.label}</span>
                  <span className="milestone-title">{m.desc}</span>
                </div>
                <div className="milestone-bottom-line">
                  {m.achieved ? (
                    <span>✓ Achieved on {m.achievedFormattedDate}</span>
                  ) : (
                    <span>🔒 Not achieved yet · Need {formatINR(Math.max(0, m.amount - totalIncome))} more</span>
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
