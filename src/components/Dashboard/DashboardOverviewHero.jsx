import React from 'react';
import { formatINR, formatINRCompact } from '../../utils/format.js';

const EyeIcon = ({ open }) => open
  ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="16" height="16"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
  : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="16" height="16"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>;

export default function DashboardOverviewHero({
  analytics,
  showPrivacy,
  onTogglePrivacy,
  onOpenMilestones,
  onOpenAnalytics,
  greeting,
  userName,
}) {
  const {
    netWorth,
    assets,
    liabilities,
    monthlySavings,
    isDeficit,
    isLowIncome,
    savingsRate,
    savingsRateDisplay,
    savingsRateStatus = { label: 'Optimal', color: '#01B574' },
    momSavingsChange,
    monthLabel,
    health = {},
    monthly = {},
    isUnfinishedMonth: topIsUnfinishedMonth,
    daysElapsed: topDaysElapsed,
    daysInMonth: topDaysInMonth,
    expectedIncome: topExpectedIncome,
    monthlyIncome: topMonthlyIncome,
    monthlyExpenses: topMonthlyExpenses,
  } = analytics || {};

  const isUnfinishedMonth = Boolean(topIsUnfinishedMonth ?? monthly.isUnfinishedMonth);
  const daysElapsed = topDaysElapsed ?? monthly.daysElapsed ?? 1;
  const daysInMonth = topDaysInMonth ?? monthly.daysInMonth ?? 30;
  const expectedIncome = topExpectedIncome ?? monthly.expectedIncome ?? null;
  const monthlyIncome = topMonthlyIncome ?? monthly.income ?? 0;
  const monthlyExpenses = topMonthlyExpenses ?? monthly.expenses ?? 0;

  // Card 2: Semantics & Mode
  // When displaying month-to-date cash flow (in-progress month or low income without valid savings rate):
  // 1. Title is "Month-to-date Cash Flow"
  // 2. Rupee amount is shown prominently with red styling for deficit
  // 3. Short explanation: "Expenses exceed income"
  // 4. Rupee amount is never labeled as a savings rate
  const isCashFlowMode = isUnfinishedMonth || savingsRate === null;
  const cardTitle = isCashFlowMode
    ? (isUnfinishedMonth ? 'Month-to-date Cash Flow' : 'Monthly Cash Flow')
    : 'Monthly Savings Rate';
  const cardSubtitle = isUnfinishedMonth
    ? `Day ${daysElapsed} of ${daysInMonth} · In progress`
    : `${monthLabel} · Settled`;

  const statusBadgeLabel = isDeficit
    ? 'Deficit'
    : (isCashFlowMode ? (monthlySavings > 0 ? 'Surplus' : 'Balanced') : `${savingsRate}% Saved`);
  const statusBadgeColor = isDeficit
    ? 'var(--dash-negative)'
    : (monthlySavings > 0 ? 'var(--dash-positive)' : 'var(--dash-text-muted)');

  // Horizontal distribution math for Income vs Expense indicator
  const totalFlow = monthlyIncome + monthlyExpenses;
  let incomeBarPct = 0;
  let expenseBarPct = 0;
  if (totalFlow > 0) {
    if (monthlyIncome === 0) {
      incomeBarPct = 0;
      expenseBarPct = 100;
    } else if (monthlyExpenses === 0) {
      incomeBarPct = 100;
      expenseBarPct = 0;
    } else {
      const rawIncomePct = (monthlyIncome / totalFlow) * 100;
      incomeBarPct = Math.max(5, Math.min(95, Math.round(rawIncomePct)));
      expenseBarPct = 100 - incomeBarPct;
    }
  }

  return (
    <div className="dash-bento-hero-grid">
      {/* ── CARD 1: Net Worth & Financial Assets Hero Card ── */}
      <div className="dash-bento-card dash-hero-nw-card">
        <div className="dash-hero-glow" />
        <div className="dash-hero-nw-header">
          <div className="dash-hero-nw-title-wrap">
            <span className="dash-hero-badge">NET WORTH OVERVIEW</span>
            <div className="dash-hero-month">{monthLabel}</div>
          </div>
          <button
            type="button"
            className="dash-privacy-toggle-btn"
            onClick={onTogglePrivacy}
            title={showPrivacy ? 'Hide financial values' : 'Show financial values'}
            aria-label="Toggle financial privacy"
          >
            <EyeIcon open={showPrivacy} />
            <span>{showPrivacy ? 'Mask' : 'Reveal'}</span>
          </button>
        </div>

        <div className="dash-hero-nw-main">
          <div className="dash-hero-nw-amount">
            {showPrivacy ? formatINR(netWorth) : '₹ ••••••'}
          </div>
          <div className="dash-hero-nw-mom">
            <span className={`dash-badge-pill ${momSavingsChange >= 0 && !isDeficit ? 'positive' : 'negative'}`}>
              {isDeficit ? 'Deficit this month' : `${momSavingsChange >= 0 ? '↑ +' : '↓ '}${momSavingsChange}% vs last mo`}
            </span>
            <span className="dash-hero-nw-mom-label">Net cash flow momentum</span>
          </div>
        </div>

        {/* 3 Pillars: Assets, Liabilities, Monthly Savings / Deficit */}
        <div className="dash-hero-nw-pillars">
          <div className="dash-nw-pillar">
            <div className="dash-pillar-lbl">Total Assets</div>
            <div className="dash-pillar-val income">
              {showPrivacy ? formatINRCompact(assets) : '••••'}
            </div>
            <div className="dash-pillar-sub">Cash & investments</div>
          </div>

          <div className="dash-nw-pillar-divider" />

          <div className="dash-nw-pillar">
            <div className="dash-pillar-lbl">Total Liabilities</div>
            <div className="dash-pillar-val expense">
              {showPrivacy ? formatINRCompact(liabilities) : '••••'}
            </div>
            <div className="dash-pillar-sub">Cards & borrowings</div>
          </div>

          <div className="dash-nw-pillar-divider" />

          <div className="dash-nw-pillar">
            <div className="dash-pillar-lbl">
              {isUnfinishedMonth ? 'MTD Cash Flow' : (isDeficit ? 'Monthly Deficit' : 'Saved This Month')}
            </div>
            <div className={`dash-pillar-val ${isDeficit ? 'expense' : 'income'}`}>
              {showPrivacy ? (
                isDeficit
                  ? `−${formatINRCompact(Math.abs(monthlySavings))}`
                  : `+${formatINRCompact(monthlySavings)}`
              ) : '••••'}
            </div>
            <div className="dash-pillar-sub">
              {isUnfinishedMonth
                ? `${daysElapsed}/${daysInMonth} days${expectedIncome ? ` · ₹${formatINRCompact(expectedIncome)} exp` : ''}`
                : (isLowIncome ? (isDeficit ? 'Deficit (Low Income)' : 'Low Income Baseline') : `${savingsRateDisplay} rate`)}
            </div>
          </div>
        </div>
      </div>

      {/* ── CARD 2: Cash Flow & Savings Rate Card ── */}
      <div className="dash-bento-card dash-hero-flow-card">
        <div className="dash-card-header-compact">
          <div className="dash-card-title-group">
            <span className="dash-bento-card-title">{cardTitle}</span>
            <span className="dash-bento-card-sub">{cardSubtitle}</span>
          </div>
          <span
            className="dash-status-dot-badge"
            style={{
              color: statusBadgeColor,
              borderColor: `${statusBadgeColor}44`,
              background: `${statusBadgeColor}15`,
            }}
          >
            {statusBadgeLabel}
          </span>
        </div>

        {/* Hero Cash Flow / Savings Stat */}
        <div className="dash-flow-hero-stat">
          <div
            className={`dash-flow-main-val ${isDeficit ? 'negative' : (monthlySavings > 0 ? 'positive' : 'neutral')}`}
          >
            {showPrivacy ? (
              isCashFlowMode ? (
                monthlySavings >= 0
                  ? `+${formatINR(monthlySavings)}`
                  : `−${formatINR(Math.abs(monthlySavings))}`
              ) : (
                `${savingsRate}%`
              )
            ) : '₹ ••••••'}
          </div>

          <div className="dash-flow-sub-row">
            <span className={`dash-flow-explain ${isDeficit ? 'negative' : ''}`}>
              {isCashFlowMode
                ? (isDeficit
                    ? 'Expenses exceed income'
                    : (monthlySavings > 0 ? 'Net cash retained' : 'Break-even cash flow'))
                : `of income saved (${showPrivacy ? (monthlySavings >= 0 ? `+${formatINRCompact(monthlySavings)}` : `−${formatINRCompact(Math.abs(monthlySavings))}`) : '••••'} net)`}
            </span>

            {/* If cash flow mode but valid savings rate is also available, show it separately with correct label */}
            {isCashFlowMode && savingsRate !== null && !isLowIncome && (
              <span className="dash-flow-rate-chip">
                {savingsRate}% Savings Rate
              </span>
            )}
          </div>
        </div>

        {/* Compact Horizontal Income-versus-Expense Indicator */}
        <div className="dash-flow-indicator-card">
          <div className="dash-flow-bar-header">
            <div className="dash-flow-col income">
              <span className="dash-flow-legend-dot income" />
              <span className="dash-flow-col-name">Income</span>
              <span className="dash-flow-col-amt">
                {showPrivacy ? formatINRCompact(monthlyIncome) : '••••'}
              </span>
            </div>
            <div className="dash-flow-col expense">
              <span className="dash-flow-col-amt">
                {showPrivacy ? formatINRCompact(monthlyExpenses) : '••••'}
              </span>
              <span className="dash-flow-col-name">Expenses</span>
              <span className="dash-flow-legend-dot expense" />
            </div>
          </div>

          <div
            className="dash-flow-bar-track"
            role="progressbar"
            aria-valuenow={incomeBarPct}
            aria-valuemin="0"
            aria-valuemax="100"
            aria-label="Income vs Expense ratio"
          >
            {incomeBarPct > 0 && (
              <div
                className="dash-flow-bar-fill income"
                style={{ width: `${incomeBarPct}%` }}
                title={`Income: ${formatINR(monthlyIncome)} (${incomeBarPct}%)`}
              />
            )}
            {expenseBarPct > 0 && (
              <div
                className="dash-flow-bar-fill expense"
                style={{ width: `${expenseBarPct}%` }}
                title={`Expenses: ${formatINR(monthlyExpenses)} (${expenseBarPct}%)`}
              />
            )}
          </div>

          <div className="dash-flow-bar-footer">
            <span className="dash-flow-footer-subtext">
              {monthlyIncome === 0
                ? 'No income recorded yet this month'
                : isDeficit
                  ? `Expenses are ${(monthlyExpenses / (monthlyIncome || 1)).toFixed(1)}x of income`
                  : savingsRate !== null
                    ? `${savingsRate}% of income saved`
                    : `${Math.max(0, Math.round((monthlySavings / (monthlyIncome || 1)) * 100))}% retained`}
            </span>
          </div>
        </div>

        {/* Supporting metrics underneath */}
        <div className="dash-flow-footer-metrics">
          <div className="dash-flow-foot-stat">
            <span className="dash-flow-foot-lbl">Income / Exp Ratio</span>
            <span className="dash-flow-foot-val">{health?.incomeExpenseRatio || '0.0'}x</span>
          </div>
          <div className="dash-flow-foot-divider" />
          <div className="dash-flow-foot-stat">
            <span className="dash-flow-foot-lbl">
              {expectedIncome ? 'Expected Income' : (savingsRate !== null && isCashFlowMode ? 'Savings Rate' : 'Projected Spend')}
            </span>
            <span
              className="dash-flow-foot-val"
              style={{ color: expectedIncome ? 'var(--dash-primary)' : 'var(--dash-text-main)' }}
            >
              {showPrivacy ? (
                expectedIncome
                  ? `₹${formatINRCompact(expectedIncome)}`
                  : (savingsRate !== null && isCashFlowMode
                      ? `${savingsRate}%`
                      : `₹${formatINRCompact(health?.projectedMonthExpense || 0)}`)
              ) : '••••'}
            </span>
          </div>
        </div>
      </div>

      {/* ── CARD 3: Emergency Runway & Health Score (Dribbble Safety Score) ── */}
      <div className="dash-bento-card dash-hero-runway-card">
        <div className="dash-card-header-compact">
          <div className="dash-card-title-group">
            <span className="dash-bento-card-title">Resilience</span>
            <span className="dash-bento-card-sub">Emergency Runway</span>
          </div>
          <span className="dash-resilience-icon" title="Financial Cushion">🛡️</span>
        </div>

        <div className="dash-runway-display">
          <div className="dash-runway-score-box">
            <span className="dash-runway-score-num">
              {health.runwayMonths >= 99 ? '> 5' : health.runwayMonths}
            </span>
            <span className="dash-runway-score-unit">
              {health.runwayMonths >= 99 ? 'years' : 'months'}
            </span>
          </div>

          <div className="dash-runway-details">
            <div className="dash-runway-stat-row">
              <span className="dash-runway-stat-lbl">Liquid Reserve</span>
              <span className="dash-runway-stat-val">
                {showPrivacy ? formatINRCompact(health.liquidAssets) : '••••'}
              </span>
            </div>
            <div className="dash-runway-stat-row">
              <span className="dash-runway-stat-lbl">3-Mo Monthly Burn</span>
              <span className="dash-runway-stat-val expense">
                {showPrivacy ? formatINRCompact(health.avgMonthlyExpense) : '••••'}
              </span>
            </div>
            <div className="dash-runway-stat-row">
              <span className="dash-runway-stat-lbl">Monthly Invested</span>
              <span className="dash-runway-stat-val" style={{ color: '#00D2D3' }}>
                {showPrivacy ? formatINRCompact(health.monthlyInvested) : '••••'}
              </span>
            </div>
          </div>
        </div>

        {/* Burn Pace Progress */}
        <div className="dash-burn-pace-wrap">
          <div className="dash-burn-pace-hdr">
            <span>Month Spend Pace</span>
            <span>{health.monthTimeElapsedPct}% of month elapsed</span>
          </div>
          <div className="dash-burn-track">
            <div
              className="dash-burn-fill"
              style={{
                width: `${Math.min(100, health.monthTimeElapsedPct)}%`,
                background: health.projectedVsLastMonthPct > 15 ? 'var(--dash-negative)' : 'var(--dash-positive)',
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
