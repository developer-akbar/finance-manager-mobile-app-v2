import React, { useState, useMemo, useEffect } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { parseDate, formatINR, formatINRCompact, txnType, txnAmount } from '../../utils/format.js';
import { ccBalances, isCreditCard } from '../Accounts/Accounts.jsx';
import AddTransaction from '../Transactions/AddTransaction.jsx';
import useSwipe from '../../hooks/useSwipe.js';
import './CashFlowForecast.css';

const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function CashFlowForecast({ onBack, backInterceptRef }) {
  const { state } = useApp();
  const { transactions, recurringRules, accounts } = state;

  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [selectedDate, setSelectedDate] = useState(() => {
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  });
  const [editTxn, setEditTxn] = useState(null);

  // Month navigation
  const handlePrevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear(y => y - 1);
    } else {
      setViewMonth(m => m - 1);
    }
  };

  const handleNextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear(y => y + 1);
    } else {
      setViewMonth(m => m + 1);
    }
  };

  // Horizontal swipe left -> next month, swipe right -> prev month
  const swipeHandlers = useSwipe(handleNextMonth, handlePrevMonth);

  // Back button interception
  useEffect(() => {
    if (!backInterceptRef) return;
    if (editTxn) {
      backInterceptRef.current = () => setEditTxn(null);
    } else {
      backInterceptRef.current = onBack;
    }
    return () => { if (backInterceptRef) backInterceptRef.current = null; };
  }, [editTxn, onBack, backInterceptRef]);

  // Current liquid balance (Money in Savings Bank + Cash only)
  const currentLiquidBalance = useMemo(() => {
    let bal = 0;
    const acctMap = {};
    for (const t of transactions) {
      const type = t['Income/Expense'] || 'Expense';
      const amt = parseFloat(t.INR || t.Amount || 0);
      const acct = t.Account || t.FromAccount || '';
      const dest = t.ToAccount || '';
      if (type === 'Income') acctMap[acct] = (acctMap[acct] || 0) + amt;
      else if (type === 'Expense') acctMap[acct] = (acctMap[acct] || 0) - amt;
      else if (type.startsWith('Transfer')) {
        acctMap[acct] = (acctMap[acct] || 0) - amt;
        acctMap[dest] = (acctMap[dest] || 0) + amt;
      }
    }
    for (const [name, b] of Object.entries(acctMap)) {
      const a = (accounts || []).find(acc => (acc.name || acc) === name);
      const isAsset = a?.isAsset !== undefined ? a.isAsset : !['credit card', 'credit', 'loan', 'emi', 'borrow', 'pay later'].some(k => name.toLowerCase().includes(k));
      if (isAsset && b > 0) bal += b;
    }
    return bal;
  }, [transactions, accounts]);

  // Projected upcoming dues and inflows for the selected month
  const { scheduledEvents, expectedInflows, expectedOutflows } = useMemo(() => {
    const events = {};
    let inflows = 0, outflows = 0;

    // 1. Process active recurring rules
    for (const r of (recurringRules || [])) {
      if (r.status !== 'active') continue;
      const amt = parseFloat(r.amount_per_part || r.total_amount || 0);
      const isInc = r.txn_type === 'Income';
      const nextD = r.next_date; // YYYY-MM-DD

      if (nextD) {
        if (!events[nextD]) events[nextD] = [];
        events[nextD].push({
          title: r.base_note || r.category || 'Recurring Rule',
          amount: amt,
          type: isInc ? 'income' : 'expense',
          category: r.category,
        });

        const [ry, rm] = nextD.split('-').map(Number);
        if (ry === viewYear && rm - 1 === viewMonth) {
          if (isInc) inflows += amt;
          else outflows += amt;
        }
      }
    }

    // 2. Process Credit Card upcoming bills with exact paymentDueDays calculation
    for (const a of (accounts || [])) {
      if (!isCreditCard(a) || !a.settlementDate || !a.paymentDueDays) continue;

      // Two potential due dates can fall in this view month:
      // (a) Bill from previous month's statement
      const prevStmt = new Date(viewYear, viewMonth - 1, a.settlementDate);
      const due1 = new Date(prevStmt.getFullYear(), prevStmt.getMonth(), prevStmt.getDate() + a.paymentDueDays);

      // (b) Bill from current month's statement
      const currStmt = new Date(viewYear, viewMonth, a.settlementDate);
      const due2 = new Date(currStmt.getFullYear(), currStmt.getMonth(), currStmt.getDate() + a.paymentDueDays);

      const candidateDues = [due1, due2];

      for (const due of candidateDues) {
        if (due.getFullYear() === viewYear && due.getMonth() === viewMonth) {
          const dueStr = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`;
          const cc = ccBalances(transactions, a.name, a.settlementDate, due);
          const payableAmt = cc.balancePayable > 0 ? cc.balancePayable : 0;

          if (!events[dueStr]) events[dueStr] = [];
          events[dueStr].push({
            title: `${a.name} Bill Due`,
            amount: payableAmt,
            type: 'due',
            category: 'Credit Card Bill',
          });

          if (payableAmt > 0) outflows += payableAmt;
        }
      }
    }

    return { scheduledEvents: events, expectedInflows: inflows, expectedOutflows: outflows };
  }, [recurringRules, accounts, transactions, viewYear, viewMonth]);

  // Projected Month-End Balance
  const projectedBalance = currentLiquidBalance + expectedInflows - expectedOutflows;

  // Build calendar matrix
  const calendarDays = useMemo(() => {
    const firstDay = new Date(viewYear, viewMonth, 1).getDay();
    const totalDays = new Date(viewYear, viewMonth + 1, 0).getDate();
    const days = [];

    // Previous month filler
    const prevTotal = new Date(viewYear, viewMonth, 0).getDate();
    for (let i = firstDay - 1; i >= 0; i--) {
      days.push({ day: prevTotal - i, isCurrent: false });
    }

    // Current month days
    for (let d = 1; d <= totalDays; d++) {
      const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const isToday = today.getFullYear() === viewYear && today.getMonth() === viewMonth && today.getDate() === d;
      const evts = scheduledEvents[dateStr] || [];
      const hasExpense = evts.some(e => e.type === 'expense');
      const hasIncome = evts.some(e => e.type === 'income');
      const hasDue = evts.some(e => e.type === 'due');

      // Check if actual transactions exist on this day
      const dayTxnDate = `${String(d).padStart(2, '0')}/${String(viewMonth + 1).padStart(2, '0')}/${viewYear}`;
      const dayTxns = transactions.filter(t => t.Date === dayTxnDate);
      const hasTxn = dayTxns.length > 0;

      days.push({
        day: d,
        dateStr,
        isCurrent: true,
        isToday,
        hasExpense: hasExpense || dayTxns.some(t => txnType(t) === 'expense'),
        hasIncome: hasIncome || dayTxns.some(t => txnType(t) === 'income'),
        hasDue,
        hasTxn,
        events: evts,
      });
    }

    return days;
  }, [viewYear, viewMonth, scheduledEvents, transactions, today]);

  // Selected date events & transactions
  const selectedDayItems = useMemo(() => {
    if (!selectedDate) return [];
    const evts = (scheduledEvents[selectedDate] || []).map(e => ({ ...e, isScheduled: true }));
    const [sy, sm, sd] = selectedDate.split('-');
    const txnDateTarget = `${sd}/${sm}/${sy}`;

    const txns = transactions
      .filter(t => t.Date === txnDateTarget)
      .map(t => ({
        rawTxn: t,
        title: t.Note || t.Category,
        amount: txnAmount(t),
        type: txnType(t),
        category: t.Category,
        account: t['Income/Expense'] === 'Transfer' ? `${t.FromAccount || t.Account} → ${t.ToAccount}` : t.Account,
        isScheduled: false,
      }));

    return [...evts, ...txns];
  }, [selectedDate, scheduledEvents, transactions]);

  return (
    <div className="forecast-screen">
      <div className="page-hdr">
        <button className="back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        </button>
        <div className="page-hdr-title">Cash Flow &amp; Calendar</div>
      </div>

      <div className="forecast-body" {...swipeHandlers}>
        {/* Month Picker Row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-card)', padding: '8px 12px', borderRadius: 12, border: '1px solid var(--border)' }}>
          <button
            onClick={handlePrevMonth}
            style={{ background: 'none', border: 'none', color: 'var(--text-primary)', fontSize: '1.2rem', cursor: 'pointer', padding: '4px 8px' }}
          >
            ‹
          </button>
          <div style={{ fontWeight: 800, fontSize: '0.92rem' }}>
            {new Date(viewYear, viewMonth, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
          </div>
          <button
            onClick={handleNextMonth}
            style={{ background: 'none', border: 'none', color: 'var(--text-primary)', fontSize: '1.2rem', cursor: 'pointer', padding: '4px 8px' }}
          >
            ›
          </button>
        </div>

        {/* Projection Banner */}
        <div className="forecast-banner">
          <div className="forecast-banner-title">Projected Month-End Liquid Balance</div>
          <div className="forecast-banner-val">{formatINR(projectedBalance)}</div>
          <div className="forecast-banner-sub">
            Current Bank &amp; Cash: {formatINRCompact(currentLiquidBalance)} • Expected Inflows: +{formatINRCompact(expectedInflows)} • Upcoming Dues: −{formatINRCompact(expectedOutflows)}
          </div>
          <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 4, opacity: 0.85 }}>
            💡 Real-time cash &amp; bank savings balance used as the baseline for this month's cash flow forecast.
          </div>
        </div>

        {/* Calendar Grid */}
        <div className="cal-grid">
          {DAYS_OF_WEEK.map(d => (
            <div key={d} className="cal-hdr-day">{d}</div>
          ))}
          {calendarDays.map((cd, idx) => {
            if (!cd.isCurrent) {
              return <div key={`prev-${idx}`} className="cal-cell other-month">{cd.day}</div>;
            }
            const isSelected = selectedDate === cd.dateStr;
            return (
              <div
                key={cd.dateStr}
                className={`cal-cell ${cd.isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}`}
                onClick={() => setSelectedDate(cd.dateStr)}
              >
                <span>{cd.day}</span>
                <div className="cal-dot-row">
                  {cd.hasIncome && <div className="cal-dot inc" />}
                  {cd.hasExpense && <div className="cal-dot exp" />}
                  {cd.hasDue && <div className="cal-dot due" />}
                </div>
              </div>
            );
          })}
        </div>

        {/* Selected Day Breakdown */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: '0.82rem', fontWeight: 800, color: 'var(--text-muted)' }}>
            Schedule &amp; Transactions for {selectedDate ? new Date(selectedDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Selected Date'}
          </div>

          {selectedDayItems.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', background: 'var(--bg-card)', padding: 18, borderRadius: 12, border: '1px solid var(--border)', fontSize: '0.78rem' }}>
              No scheduled dues or transactions on this day.
            </div>
          ) : (
            selectedDayItems.map((item, i) => (
              <div
                key={i}
                className="forecast-due-item"
                style={{ cursor: item.rawTxn ? 'pointer' : 'default' }}
                onClick={() => {
                  if (item.rawTxn) setEditTxn(item.rawTxn);
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {item.isScheduled && <span style={{ fontSize: '0.65rem', background: 'rgba(0,229,160,0.15)', color: 'var(--accent)', padding: '1px 5px', borderRadius: 4, fontWeight: 700 }}>SCHEDULED</span>}
                    <span style={{ fontSize: '0.85rem', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
                  </div>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                    {item.category} {item.account ? `• ${item.account}` : ''}
                  </span>
                </div>
                {item.amount > 0 && (
                  <span style={{ fontSize: '0.9rem', fontWeight: 800, color: item.type === 'income' ? 'var(--income)' : item.type === 'expense' ? 'var(--expense)' : 'var(--transfer)', flexShrink: 0 }}>
                    {item.type === 'income' ? '+' : item.type === 'expense' ? '−' : '⇄'}{formatINR(item.amount)}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {editTxn && (
        <AddTransaction
          editTransaction={editTxn}
          onClose={() => setEditTxn(null)}
          onSaveAndContinue={() => setEditTxn(null)}
          backInterceptRef={backInterceptRef}
        />
      )}
    </div>
  );
}
