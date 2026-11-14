import React from 'react';
import { formatINRCompact } from '../../utils/format.js';

export default function DashboardKpiStrip({ analytics, showPrivacy }) {
  const {
    monthlyIncome,
    monthlyExpenses,
    monthlySavings,
    isDeficit,
    savingsRateDisplay,
    momIncomeChange,
    momExpenseChange,
    health,
    monthly = {},
  } = analytics;

  const isUnfinishedMonth = monthly.isUnfinishedMonth || false;
  const daysElapsed = monthly.daysElapsed || 1;
  const daysInMonth = monthly.daysInMonth || 30;

  return (
    <div className="dash-bento-kpi-grid">
      {/* ── KPI 1: Monthly Income ── */}
      <div className="dash-bento-kpi-card">
        <div className="dash-kpi-top">
          <div className="dash-kpi-icon-pill" style={{ background: 'rgba(0, 117, 255, 0.14)', color: '#0075FF' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" width="18" height="18"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
          </div>
          <span className={`dash-kpi-badge ${momIncomeChange >= 0 ? 'positive' : 'negative'}`}>
            {momIncomeChange >= 0 ? '↑ +' : '↓ '}{momIncomeChange}%
          </span>
        </div>
        <div className="dash-kpi-label">Monthly Income</div>
        <div className="dash-kpi-value income">
          {showPrivacy ? formatINRCompact(monthlyIncome) : '₹ ••••'}
        </div>
        <div className="dash-kpi-sub">vs last month</div>
      </div>

      {/* ── KPI 2: Monthly Expenses ── */}
      <div className="dash-bento-kpi-card">
        <div className="dash-kpi-top">
          <div className="dash-kpi-icon-pill" style={{ background: 'rgba(238, 93, 80, 0.14)', color: '#EE5D50' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" width="18" height="18"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zM3 6h18M16 10a4 4 0 0 1-8 0" /></svg>
          </div>
          <span className={`dash-kpi-badge ${momExpenseChange <= 0 ? 'positive' : 'negative'}`}>
            {momExpenseChange <= 0 ? '↓ ' : '↑ +'}{momExpenseChange}%
          </span>
        </div>
        <div className="dash-kpi-label">Monthly Expenses</div>
        <div className="dash-kpi-value expense">
          {showPrivacy ? formatINRCompact(monthlyExpenses) : '₹ ••••'}
        </div>
        <div className="dash-kpi-sub">
          {momExpenseChange <= 0 ? 'spending decreased' : 'spending increased'}
        </div>
      </div>

      {/* ── KPI 3: Net Savings / Monthly Deficit / MTD Cash Flow ── */}
      <div className="dash-bento-kpi-card">
        <div className="dash-kpi-top">
          <div
            className="dash-kpi-icon-pill"
            style={{
              background: isDeficit ? 'rgba(238, 93, 80, 0.14)' : 'rgba(1, 181, 116, 0.14)',
              color: isDeficit ? '#EE5D50' : '#01B574',
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" width="18" height="18"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
          </div>
          <span className={`dash-kpi-badge ${isDeficit ? 'negative' : 'neutral'}`}>
            {isUnfinishedMonth ? 'MTD Flow' : (isDeficit ? 'Deficit' : `${savingsRateDisplay} rate`)}
          </span>
        </div>
        <div className="dash-kpi-label">
          {isUnfinishedMonth ? 'MTD Cash Flow' : (isDeficit ? 'Monthly Deficit' : 'Net Savings')}
        </div>
        <div className={`dash-kpi-value ${isDeficit ? 'expense' : 'income'}`}>
          {showPrivacy ? (
            isDeficit
              ? `−${formatINRCompact(Math.abs(monthlySavings))}`
              : `+${formatINRCompact(monthlySavings)}`
          ) : '₹ ••••'}
        </div>
        <div className="dash-kpi-sub">
          {isUnfinishedMonth
            ? `${daysElapsed} of ${daysInMonth} days elapsed`
            : (isDeficit ? 'expenses exceeded income' : 'retained cash flow')}
        </div>
      </div>

      {/* ── KPI 4: Monthly Investments ── */}
      <div className="dash-bento-kpi-card">
        <div className="dash-kpi-top">
          <div className="dash-kpi-icon-pill" style={{ background: 'rgba(0, 210, 211, 0.14)', color: '#00D2D3' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" width="18" height="18"><path d="M3 3v18h18M18 9l-6 6-4-4-5 5" /></svg>
          </div>
          <span className="dash-kpi-badge highlight">
            Growth
          </span>
        </div>
        <div className="dash-kpi-label">Invested (Month)</div>
        <div className="dash-kpi-value" style={{ color: '#00D2D3' }}>
          {showPrivacy ? formatINRCompact(health.monthlyInvested) : '₹ ••••'}
        </div>
        <div className="dash-kpi-sub">
          {showPrivacy ? `${formatINRCompact(health.totalInvested)} cumulative` : 'all-time active'}
        </div>
      </div>
    </div>
  );
}
