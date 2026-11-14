import React from 'react';
import { formatINR } from '../../../utils/format.js';
import { formatSignedCurrency, formatSignedPercent } from '../../../utils/portfolioAggregation.js';

export default function PortfolioSummary({ 
  activeCostBasis = 0,
  activeUnits = 0,
  totalRealizedPnl = 0,
  totalValuedAmount = null,
  valuedCostBasis = 0,
  valuedUnrealizedPnl = null,
  valuedReturnPercent = null,
  totalUnrealizedPnl = null,
  unrealizedReturnPercent = null,
  portfolioXirr = null,
  total1DChange = null,
  portfolio1DPct = null,
  valid1DCount = 0,
  hasMfIn1D = false,
  hasEquityIn1D = false,
  isFullyValued = false,
  hasPartialValuation = false,
  valuedCount = 0,
  totalActiveCount = 0,
  isFetchingValuations = false,
  brokerageCash = 0,
  totalFinancialAssets = 0,
  activeHoldingsCount = 0,
  redeemedCount = 0,
  dataIssuesCount = 0,
  platformCount = 0,
  onOpenDataIssues = null
}) {

  const getPnlClass = (val) => {
    if (val > 0) return 'pos';
    if (val < 0) return 'neg';
    return 'neutral';
  };

  return (
    <div className="portfolio-summary-section">
      {/* ── PRIMARY KPI BENTO GRID ─────────────────────────────────────────── */}
      <div className="portfolio-kpi-grid">
        {/* KPI 1: CURRENT VALUE */}
        <div className="portfolio-kpi-card hero-primary">
          <div className="portfolio-kpi-header">
            <span className="portfolio-kpi-lbl">CURRENT VALUE</span>
            <div className="portfolio-kpi-coverage">
              {isFullyValued ? (
                <span className="coverage-badge green">
                  <span className="coverage-dot green" />
                  {valuedCount}/{totalActiveCount} valued
                </span>
              ) : hasPartialValuation ? (
                <span className="coverage-badge orange">
                  <span className="coverage-dot orange" />
                  {valuedCount}/{totalActiveCount} valued
                </span>
              ) : (
                <span className="coverage-badge gray">
                  <span className="coverage-dot gray" />
                  Cost basis
                </span>
              )}
            </div>
          </div>
          <div className="portfolio-kpi-val num-tabular">
            {isFetchingValuations && totalValuedAmount === null ? (
              <span className="kpi-val-na">Loading...</span>
            ) : hasPartialValuation && totalValuedAmount !== null ? (
              formatINR(totalValuedAmount)
            ) : (
              <span className="kpi-val-na">NAV / LTP unavailable</span>
            )}
          </div>
          <div className="portfolio-kpi-sub">
            {isFullyValued ? (
              <span className="kpi-sub-text">100% Valuation coverage</span>
            ) : hasPartialValuation ? (
              <span className="kpi-sub-text">Partial valuation · {totalActiveCount - valuedCount} unvalued</span>
            ) : (
              <span className="kpi-sub-text">Awaiting live market prices & NAV</span>
            )}
          </div>
        </div>

        {/* KPI 2: INVESTED */}
        <div className="portfolio-kpi-card">
          <div className="portfolio-kpi-header">
            <span className="portfolio-kpi-lbl">ACTIVE INVESTED</span>
          </div>
          <div className="portfolio-kpi-val num-tabular">
            {formatINR(activeCostBasis)}
          </div>
          <div className="portfolio-kpi-sub">
            <span className="kpi-sub-text">Active deployed cost basis</span>
          </div>
        </div>

        {/* KPI 3: UNREALIZED P&L */}
        <div className="portfolio-kpi-card">
          <div className="portfolio-kpi-header">
            <span className="portfolio-kpi-lbl">UNREALIZED P&L</span>
            {hasPartialValuation && valuedReturnPercent !== null && (
              <span className={`portfolio-kpi-pill ${getPnlClass(valuedReturnPercent)} num-tabular`}>
                {valuedReturnPercent >= 0 ? `+${valuedReturnPercent}%` : `${valuedReturnPercent}%`}
              </span>
            )}
          </div>
          <div className={`portfolio-kpi-val num-tabular ${getPnlClass(valuedUnrealizedPnl)}`}>
            {isFetchingValuations && valuedUnrealizedPnl === null ? (
              <span className="kpi-val-na">Loading...</span>
            ) : hasPartialValuation && valuedUnrealizedPnl !== null ? (
              formatSignedCurrency(valuedUnrealizedPnl)
            ) : (
              <span className="kpi-val-na">—</span>
            )}
          </div>
          <div className="portfolio-kpi-sub">
            <span className="kpi-sub-text">
              {hasPartialValuation && valuedReturnPercent !== null 
                ? 'Total unrealized gain/loss' 
                : 'Awaiting market valuation'}
            </span>
          </div>
        </div>

        {/* KPI 4: XIRR */}
        <div className="portfolio-kpi-card">
          <div className="portfolio-kpi-header">
            <span className="portfolio-kpi-lbl">PORTFOLIO XIRR</span>
            <span className="portfolio-kpi-info-icon" title="Extended Internal Rate of Return (annualized compounding return based on exact cash-flow dates)">ⓘ</span>
          </div>
          <div className={`portfolio-kpi-val num-tabular ${getPnlClass(portfolioXirr)}`}>
            {portfolioXirr !== null ? (
              formatSignedPercent(portfolioXirr)
            ) : (
              <span className="kpi-val-na">—</span>
            )}
          </div>
          <div className="portfolio-kpi-sub">
            <span className="kpi-sub-text">Annualized cash flow return</span>
          </div>
        </div>

        {/* KPI 5: 1D RETURNS */}
        <div 
          className="portfolio-kpi-card" 
          title={hasMfIn1D 
            ? (hasEquityIn1D ? "Market movement since previous close & based on latest NAV vs previous NAV" : "Based on latest NAV vs previous NAV") 
            : "Market movement since previous close"
          }
        >
          <div className="portfolio-kpi-header">
            <span className="portfolio-kpi-lbl">1D RETURNS</span>
            {portfolio1DPct !== null && (
              <span className={`portfolio-kpi-pill ${getPnlClass(portfolio1DPct)} num-tabular`}>
                {portfolio1DPct >= 0 ? `+${portfolio1DPct}%` : `${portfolio1DPct}%`}
              </span>
            )}
          </div>
          <div className={`portfolio-kpi-val num-tabular ${getPnlClass(total1DChange)}`}>
            {isFetchingValuations && total1DChange === null ? (
              <span className="kpi-val-na">Loading...</span>
            ) : total1DChange !== null ? (
              <>
                <span className="kpi-dir-arrow">{total1DChange > 0 ? '↑' : total1DChange < 0 ? '↓' : '→'}</span>
                {' '}{formatSignedCurrency(total1DChange)}
              </>
            ) : (
              <span className="kpi-val-na">—</span>
            )}
          </div>
          <div className="portfolio-kpi-sub">
            <span className="kpi-sub-text">
              {hasMfIn1D && !hasEquityIn1D 
                ? 'Latest NAV vs previous close' 
                : hasMfIn1D && hasEquityIn1D
                  ? 'Daily market & NAV movement'
                  : 'Daily market close change'}
            </span>
          </div>
        </div>

        {/* KPI 6: REALIZED P&L */}
        <div className="portfolio-kpi-card">
          <div className="portfolio-kpi-header">
            <span className="portfolio-kpi-lbl">REALIZED P&L</span>
          </div>
          <div className={`portfolio-kpi-val num-tabular ${getPnlClass(totalRealizedPnl)}`}>
            {formatSignedCurrency(totalRealizedPnl)}
          </div>
          <div className="portfolio-kpi-sub">
            <span className="kpi-sub-text">Net realized profit / loss</span>
          </div>
        </div>

        {/* KPI 7: UNINVESTED BROKERAGE CASH (Conditional) */}
        {brokerageCash > 0 && (
          <div className="portfolio-kpi-card cash-card">
            <div className="portfolio-kpi-header">
              <span className="portfolio-kpi-lbl">BROKERAGE CASH</span>
              <span className="portfolio-kpi-pill cash">Liquid</span>
            </div>
            <div className="portfolio-kpi-val cash num-tabular">
              {formatINR(brokerageCash)}
            </div>
            <div className="portfolio-kpi-sub">
              <span className="kpi-sub-text">Available trading balance</span>
            </div>
          </div>
        )}
      </div>

      {/* ── AUXILIARY STATUS STRIP ─────────────────────────────────────────── */}
      <div className="portfolio-status-strip">
        <div className="status-strip-chip chip-holdings">
          <span className="status-chip-dot green" />
          <span className="status-chip-lbl">Active Holdings</span>
          <strong className="status-chip-num num-tabular">{activeHoldingsCount}</strong>
        </div>
        <div className="status-strip-chip chip-redeemed">
          <span className="status-chip-dot gray" />
          <span className="status-chip-lbl">Redeemed</span>
          <strong className="status-chip-num num-tabular">{redeemedCount}</strong>
        </div>
        <div className="status-strip-chip chip-platforms">
          <span className="status-chip-dot blue" />
          <span className="status-chip-lbl">Platforms</span>
          <strong className="status-chip-num num-tabular">{platformCount}</strong>
        </div>
        <div className="status-strip-chip chip-cash">
          <span className="status-chip-dot teal" />
          <span className="status-chip-lbl">Cash</span>
          <strong className="status-chip-num num-tabular">{formatINR(brokerageCash || 0)}</strong>
        </div>
        {dataIssuesCount > 0 && (
          <button 
            type="button"
            className="status-strip-chip chip-warning clickable"
            onClick={onOpenDataIssues}
            title="Click to view historical data issues"
          >
            <span className="status-chip-dot orange" />
            <span className="status-chip-lbl">Data Issues</span>
            <strong className="status-chip-num num-tabular">{dataIssuesCount}</strong>
          </button>
        )}
      </div>
    </div>
  );
}

