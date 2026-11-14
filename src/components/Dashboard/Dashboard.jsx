import React, { useState, useEffect, useMemo } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { parseBankSMS } from '../../utils/smsParser.js';
import { ccBalances, isCreditCard, ccDaysUntilDue, ccNextDueDate } from '../Accounts/Accounts.jsx';
import DebtTracker from '../Accounts/DebtTracker.jsx';
import CardOptimizer from '../Accounts/CardOptimizer.jsx';
import GroupSplitManager from '../Groups/GroupSplitManager.jsx';
import StockManager from '../Accounts/StockManager.jsx';
import InvestmentsPortfolio from '../Accounts/InvestmentsPortfolio.jsx';
import AddTransaction from '../Transactions/AddTransaction.jsx';
import { useDueAlertState } from '../../hooks/useDueAlertState.js';
import { calculateIncomeMilestones } from '../../utils/milestones.js';
import GlobalSyncBadge from '../Common/GlobalSyncBadge.jsx';

import { useDashboardAnalytics } from './useDashboardAnalytics.js';
import DashboardOverviewHero from './DashboardOverviewHero.jsx';
import DashboardKpiStrip from './DashboardKpiStrip.jsx';
import DashboardCashFlowChart from './DashboardCashFlowChart.jsx';
import DashboardSpendingIntel from './DashboardSpendingIntel.jsx';
import DashboardInvestmentSummary from './DashboardInvestmentSummary.jsx';
import DashboardDebtCards from './DashboardDebtCards.jsx';
import DashboardRecentActivity from './DashboardRecentActivity.jsx';

import './Dashboard.css';

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
const now = new Date();
const todayTip = TIPS[now.getDate() % TIPS.length];

export default function Dashboard({ onAddTransaction, backInterceptRef }) {
  const { state, navigate } = useApp();
  const { transactions = [], accounts = [], budgets = [], recurringRules = [], settings = {} } = state;
  const { paidDueAlerts, dismissedDueAlerts, todayKey, markPaid, markDismissed } = useDueAlertState();

  // Privacy: masked amounts by default
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showMilestones, setShowMilestones] = useState(false);
  const [detectedSmsTxn, setDetectedSmsTxn] = useState(null);

  // Sub-screen navigation states
  const [showPortfolio, setShowPortfolio] = useState(false);
  const [showGroups, setShowGroups] = useState(false);
  const [showOptimizer, setShowOptimizer] = useState(false);
  const [showDebtTracker, setShowDebtTracker] = useState(false);
  const [showStockManager, setShowStockManager] = useState(false);
  const [settlePrefill, setSettlePrefill] = useState(null);

  // Derive unified dashboard analytics in a single memoized pass
  const analytics = useDashboardAnalytics({
    transactions,
    accounts,
    budgets,
    recurringRules,
    settings,
  });

  // Income milestones calculation
  const incomeMilestones = useMemo(() => calculateIncomeMilestones(transactions), [transactions]);

  // Credit Card due alerts
  const dueAlerts = useMemo(() => {
    const today = new Date();
    const alerts = [];
    for (const a of accounts) {
      if (!isCreditCard(a) || !a.settlementDate || !a.paymentDueDays) continue;
      if (paidDueAlerts.has(a.name)) continue;
      if (dismissedDueAlerts[a.name] === todayKey) continue;
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
  }, [accounts, transactions, paidDueAlerts, dismissedDueAlerts, todayKey]);

  // Sync back button intercepts dynamically
  useEffect(() => {
    if (!backInterceptRef) return;
    if (showMilestones) {
      backInterceptRef.current = () => setShowMilestones(false);
    } else if (showPortfolio) {
      backInterceptRef.current = () => setShowPortfolio(false);
    } else if (showGroups) {
      backInterceptRef.current = () => setShowGroups(false);
    } else if (showOptimizer) {
      backInterceptRef.current = () => setShowOptimizer(false);
    } else if (showDebtTracker) {
      backInterceptRef.current = () => setShowDebtTracker(false);
    } else if (showStockManager) {
      backInterceptRef.current = () => setShowStockManager(false);
    } else {
      backInterceptRef.current = null;
    }
    return () => {
      if (backInterceptRef) backInterceptRef.current = null;
    };
  }, [showMilestones, showPortfolio, showGroups, showOptimizer, showDebtTracker, showStockManager, backInterceptRef]);

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
      setShowPortfolio(false);
      setShowGroups(false);
      setShowOptimizer(false);
      setShowDebtTracker(false);
      setShowStockManager(false);
      setSettlePrefill(null);
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
  const rawName = settings?.name || '';
  const name = rawName ? rawName.replace(/\b\w/g, c => c.toUpperCase()) : '';

  // Sub-screen renders
  if (showPortfolio) {
    return <InvestmentsPortfolio onBack={() => setShowPortfolio(false)} backInterceptRef={backInterceptRef} />;
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
          onSettle={({ name, amount, type, linkedTxnId }) => {
            const firstSavings = (accounts || []).find(a => !['credit card', 'credit', 'lend', 'borrow'].some(k => (a.name || a).toLowerCase().includes(k))) || 'Cash';
            const bankName = typeof firstSavings === 'object' ? firstSavings.name : firstSavings;
            setSettlePrefill({
              type: 'Transfer-Out',
              fromAccount: type === 'receive' ? 'Lend' : bankName,
              toAccount: type === 'receive' ? '' : 'Borrow',
              amount: String(amount),
              note: type === 'receive' ? `From ${name}` : `To ${name}`,
              tags: linkedTxnId ? `#debt_ref_${linkedTxnId}` : '',
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
            prefillTags={settlePrefill.tags}
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
      {/* ── TOP GREETING & HEADER BAR ── */}
      <div className="dash-greeting">
        <div className="dash-hello">
          {greeting}{name ? `, ${name}` : ' 👋'}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <GlobalSyncBadge mobile />
          <button
            type="button"
            className="dash-milestones-btn"
            onClick={() => setShowMilestones(true)}
            title="Financial Milestones & Achievements"
            aria-label="Financial Milestones"
            style={{
              padding: '6px 10px',
              borderRadius: 14,
              fontSize: '0.8rem',
              fontWeight: 700,
              border: '1px solid var(--dash-border)',
              background: 'var(--dash-surface)',
              color: 'var(--dash-text-main)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              position: 'relative',
            }}
          >
            <span style={{ fontSize: '1rem', lineHeight: 1 }}>🏆</span>
            {incomeMilestones.achievedCount > 0 && (
              <span style={{
                position: 'absolute',
                top: -3,
                right: -3,
                minWidth: 15,
                height: 15,
                borderRadius: 8,
                background: 'var(--dash-primary)',
                color: '#FFFFFF',
                fontSize: '0.58rem',
                fontWeight: 900,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 3px',
                lineHeight: 1,
                border: '1.5px solid var(--dash-card-bg)',
              }}>
                {incomeMilestones.achievedCount}
              </span>
            )}
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
              background: 'linear-gradient(135deg, rgba(0, 117, 255, 0.15), rgba(0, 210, 211, 0.12))',
              border: '1px solid var(--dash-primary)',
              borderRadius: 14,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.7rem', fontWeight: 800, color: 'var(--dash-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  ⚡ SMS / UPI Alert Detected
                </div>
                <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--dash-text-main)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
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
                  style={{ background: 'none', border: 'none', color: 'var(--dash-text-muted)', fontSize: '0.85rem', padding: '4px 6px', cursor: 'pointer' }}
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

          {/* ── ROW 1: WELCOME & FINANCIAL OVERVIEW HERO BENTO GRID ── */}
          <DashboardOverviewHero
            analytics={analytics}
            showPrivacy={showPrivacy}
            onTogglePrivacy={() => setShowPrivacy(v => !v)}
            onOpenMilestones={() => setShowMilestones(true)}
            onOpenAnalytics={() => navigate('analytics')}
            greeting={greeting}
            userName={name}
          />

          {/* ── QUICK FEATURE SHORTCUTS PILLS ── */}
          <div className="dash-shortcuts-strip">
            {[
              { id: 'portfolio', label: 'Portfolio', icon: '📈', onClick: () => setShowPortfolio(true) },
              { id: 'debt', label: 'Debt Tracker', icon: '🤝', onClick: () => setShowDebtTracker(true) },
              { id: 'stock', label: 'Stock Inventory', icon: '🥫', onClick: () => setShowStockManager(true) },
              { id: 'perks', label: 'Card Perks', icon: '💳', onClick: () => setShowOptimizer(true) },
              { id: 'groups', label: 'Groups', icon: '👥', onClick: () => setShowGroups(true) },
              { id: 'analytics', label: 'Analytics', icon: '📊', onClick: () => navigate('analytics') },
              { id: 'milestones', label: 'Milestones', icon: '🏆', onClick: () => setShowMilestones(true) },
            ].map(item => (
              <button
                key={item.id}
                type="button"
                className="dash-shortcut-pill"
                onClick={item.onClick}
              >
                <span className="dash-shortcut-icon">{item.icon}</span>
                <span>{item.label}</span>
              </button>
            ))}
          </div>

          {/* ── ROW 2: MODULAR SAAS KPI CARDS STRIP ── */}
          <DashboardKpiStrip
            analytics={analytics}
            showPrivacy={showPrivacy}
          />

          {/* ── ROW 3: CASH FLOW ANALYTICS & SPENDING INTELLIGENCE ── */}
          <div className="dash-bento-workspace">
            <DashboardCashFlowChart
              analytics={analytics}
              showPrivacy={showPrivacy}
            />
            <DashboardSpendingIntel
              analytics={analytics}
              showPrivacy={showPrivacy}
              onNavigateCategories={(cat) => navigate('categories', {
                type: 'Expense',
                category: cat,
                period: 'Month',
                year: now.getFullYear(),
                month: now.getMonth(),
              })}
              onNavigateTransactions={(filter) => navigate('transactions', filter)}
            />
          </div>

          {/* ── ROW 4: INVESTMENTS & DEBTS BENTO SPLIT ── */}
          <div className="dash-bento-split-row">
            <DashboardInvestmentSummary
              transactions={transactions}
              settings={settings}
              showPrivacy={showPrivacy}
              onOpenPortfolio={() => setShowPortfolio(true)}
            />
            <DashboardDebtCards
              analytics={analytics}
              showPrivacy={showPrivacy}
              onOpenDebtTracker={() => setShowDebtTracker(true)}
              onOpenAccounts={(acctName) => navigate('accounts', { selectAccount: acctName })}
            />
          </div>

          {/* ── ROW 5: RECENT ACTIVITY & INTELLIGENCE TIMELINE ── */}
          <DashboardRecentActivity
            analytics={analytics}
            showPrivacy={showPrivacy}
            dueAlerts={dueAlerts}
            onPayDueAlert={(acctName) => navigate('accounts', { selectAccount: acctName })}
            onDismissDueAlert={(acctName) => markDismissed(acctName)}
            onNavigateTransactions={() => navigate('transactions')}
            onNavigateSettings={() => navigate('settings')}
          />

          {/* ── TIP OF THE DAY CARD ── */}
          <div className="dash-tip-card">
            <span className="dash-tip-icon">{todayTip.icon}</span>
            <span className="dash-tip-text">{todayTip.text}</span>
          </div>

          {/* ── FINANCIAL MILESTONES MODAL / ACHIEVEMENTS SHEET ── */}
          {showMilestones && (
            <FinancialMilestonesModal
              incomeMilestones={incomeMilestones}
              onClose={() => setShowMilestones(false)}
            />
          )}

        </div> {/* End app-container */}
      </div> {/* End dash-scrollable-content */}

      {/* Floating Add FAB on Dashboard */}
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
            <span className="milestones-summary-val">{totalIncome.toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })}</span>
          </div>
          <div className="progress-track" style={{ height: 6, borderRadius: 3, marginTop: 4 }}>
            <div
              className="progress-fill"
              style={{
                width: `${pct}%`,
                background: 'linear-gradient(90deg, var(--dash-positive), var(--dash-secondary))',
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
                    <span>🔒 Not achieved yet · Need {Math.max(0, m.amount - totalIncome).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })} more</span>
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
