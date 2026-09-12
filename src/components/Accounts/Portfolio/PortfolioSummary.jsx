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
    return '';
  };

  return (
    <div className="portfolio-summary-section">
      {/* Phase 5A Compact Modern Summary Layer */}
      <div className="portfolio-hero-grid">
        {/* Metric 1: CURRENT VALUE */}
        <div className="hero-kpi-card">
          <div className="flex-between align-center mb-1">
            <div className="hero-kpi-lbl">CURRENT VALUE</div>
            <div className="valuation-coverage-indicator text-xs text-muted">
              {isFullyValued ? (
                <span className="coverage-badge green">{valuedCount} of {totalActiveCount} holdings valued</span>
              ) : hasPartialValuation ? (
                <span className="coverage-badge orange">{valuedCount} of {totalActiveCount} holdings valued</span>
              ) : (
                <span className="coverage-badge gray">0 of {totalActiveCount} valued</span>
              )}
            </div>
          </div>
          <div className="hero-kpi-val num-tabular">
            {isFetchingValuations && totalValuedAmount === null ? (
              <span className="kpi-val-na">Loading...</span>
            ) : hasPartialValuation && totalValuedAmount !== null ? (
              formatINR(totalValuedAmount)
            ) : (
              <span className="kpi-val-na">NAV / LTP unavailable</span>
            )}
          </div>
          <div className="hero-kpi-sub">
            {isFullyValued ? (
              '100% Valuation coverage'
            ) : hasPartialValuation ? (
              `Partial valuation · ${totalActiveCount - valuedCount} unvalued`
            ) : (
              'Awaiting live market prices & NAV'
            )}
          </div>
        </div>

        {/* Metric 2: INVESTED */}
        <div className="hero-kpi-card">
          <div className="hero-kpi-lbl">INVESTED</div>
          <div className="hero-kpi-val primary num-tabular">{formatINR(activeCostBasis)}</div>
          <div className="hero-kpi-sub">
            Active cost basis · {activeHoldingsCount} holdings
          </div>
        </div>

        {/* Metric 3: UNREALIZED P&L */}
        <div className="hero-kpi-card">
          <div className="hero-kpi-lbl">UNREALIZED P&L</div>
          <div className="hero-kpi-val num-tabular">
            {isFetchingValuations && valuedUnrealizedPnl === null ? (
              <span className="kpi-val-na">Loading...</span>
            ) : hasPartialValuation && valuedUnrealizedPnl !== null ? (
              <span className={getPnlClass(valuedUnrealizedPnl)}>
                {formatSignedCurrency(valuedUnrealizedPnl)}
              </span>
            ) : (
              <span className="kpi-val-na">—</span>
            )}
          </div>
          <div className="hero-kpi-sub num-tabular">
            {hasPartialValuation && valuedReturnPercent !== null ? (
              <span className={getPnlClass(valuedReturnPercent)}>
                {formatSignedPercent(valuedReturnPercent)} return
              </span>
            ) : (
              'Awaiting market prices'
            )}
          </div>
        </div>

        {/* Metric 4: XIRR */}
        <div className="hero-kpi-card">
          <div className="hero-kpi-lbl">XIRR</div>
          <div className="hero-kpi-val num-tabular">
            {portfolioXirr !== null ? (
              <span className={getPnlClass(portfolioXirr)}>
                {formatSignedPercent(portfolioXirr)}
              </span>
            ) : (
              <span className="kpi-val-na">—</span>
            )}
          </div>
          <div className="hero-kpi-sub">
            Annualized cash flow return
          </div>
        </div>

        {/* Metric 5: 1D RETURNS */}
        <div 
          className="hero-kpi-card" 
          title={hasMfIn1D 
            ? (hasEquityIn1D ? "Market movement since previous close & based on latest NAV vs previous NAV" : "Based on latest NAV vs previous NAV") 
            : "Market movement since previous close"
          }
        >
          <div className="hero-kpi-lbl">1D RETURNS</div>
          <div className="hero-kpi-val num-tabular">
            {isFetchingValuations && total1DChange === null ? (
              <span className="kpi-val-na">Loading...</span>
            ) : total1DChange !== null && portfolio1DPct !== null ? (
              <span className={getPnlClass(total1DChange)}>
                {total1DChange > 0 ? '↑ ' : total1DChange < 0 ? '↓ ' : '→ '}
                {formatSignedCurrency(total1DChange)} ({formatSignedPercent(portfolio1DPct)})
              </span>
            ) : (
              <span className="kpi-val-na">—</span>
            )}
          </div>
          <div className="hero-kpi-sub">
            {total1DChange !== null ? (
              hasMfIn1D && !hasEquityIn1D 
                ? 'Based on latest NAV vs previous NAV' 
                : hasMfIn1D && hasEquityIn1D
                  ? 'Market movement since previous close / NAV'
                  : 'Market movement since previous close'
            ) : (
              'Market movement since previous close'
            )}
          </div>
        </div>

        {/* Realized P&L */}
        <div className="hero-kpi-card secondary-kpi">
          <div className="hero-kpi-lbl">REALIZED P&L</div>
          <div className="hero-kpi-val num-tabular">
            <span className={getPnlClass(totalRealizedPnl)}>
              {formatSignedCurrency(totalRealizedPnl)}
            </span>
          </div>
          <div className="hero-kpi-sub">
            Net realized P&L ({redeemedCount} closed)
          </div>
        </div>

        {/* Uninvested Brokerage Cash */}
        {brokerageCash > 0 && (
          <div className="hero-kpi-card cash-card secondary-kpi">
            <div className="hero-kpi-lbl">UNINVESTED BROKERAGE CASH</div>
            <div className="hero-kpi-val cash num-tabular">{formatINR(brokerageCash)}</div>
            <div className="hero-kpi-sub">
              Available cash balance
            </div>
          </div>
        )}
      </div>

      {/* Auxiliary Status Strip */}
      <div className="portfolio-status-strip">
        <div className="status-strip-pill">
          <span className="status-dot green" />
          <span>Active Holdings: <strong>{activeHoldingsCount}</strong></span>
        </div>
        <div className="status-strip-pill">
          <span className="status-dot gray" />
          <span>Redeemed Positions: <strong>{redeemedCount}</strong></span>
        </div>
        <div className="status-strip-pill">
          <span className="status-dot blue" />
          <span>Platforms: <strong>{platformCount}</strong></span>
        </div>
        {brokerageCash > 0 && (
          <div className="status-strip-pill cash-pill">
            <span className="status-dot teal" />
            <span>Brokerage Cash: <strong>{formatINR(brokerageCash)}</strong></span>
          </div>
        )}
        {dataIssuesCount > 0 && (
          <div 
            className="status-strip-pill warning clickable"
            onClick={onOpenDataIssues}
            title="Click to view historical data issues"
          >
            <span className="status-dot orange" />
            <span>Portfolio health · <strong>{dataIssuesCount} issue</strong></span>
          </div>
        )}
      </div>
    </div>
  );
}

