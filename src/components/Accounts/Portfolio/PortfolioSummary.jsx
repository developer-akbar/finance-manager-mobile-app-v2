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
      {/* Primary KPI Hero Grid */}
      <div className="portfolio-hero-grid">
        {/* Card 1: Active Invested Cost */}
        <div className="hero-kpi-card">
          <div className="hero-kpi-lbl">ACTIVE INVESTED COST</div>
          <div className="hero-kpi-val primary num-tabular">{formatINR(activeCostBasis)}</div>
          <div className="hero-kpi-sub">
            Cost basis of current holdings · {activeHoldingsCount} schemes ({activeUnits.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} units)
          </div>
        </div>

        {/* Card 2: Current Market Value */}
        <div className="hero-kpi-card">
          <div className="hero-kpi-lbl">CURRENT MARKET VALUE</div>
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
              <span className="badge-partial-val">Partial valuation · {valuedCount} of {totalActiveCount} schemes valued</span>
            ) : (
              'Awaiting live market prices & NAV'
            )}
          </div>
        </div>

        {/* Card 3: Unrealized P&L */}
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
            {isFullyValued && unrealizedReturnPercent !== null ? (
              <span className={getPnlClass(unrealizedReturnPercent)}>
                {formatSignedPercent(unrealizedReturnPercent)} total return
              </span>
            ) : hasPartialValuation && valuedReturnPercent !== null ? (
              <span className={getPnlClass(valuedReturnPercent)}>
                {formatSignedPercent(valuedReturnPercent)} (across {valuedCount} valued schemes)
              </span>
            ) : (
              'Awaiting market prices / NAV'
            )}
          </div>
        </div>

        {/* Card 4: Historical Realized P&L (Always available immediately from ledger) */}
        <div className="hero-kpi-card">
          <div className="hero-kpi-lbl">HISTORICAL REALIZED P&L</div>
          <div className="hero-kpi-val num-tabular">
            <span className={getPnlClass(totalRealizedPnl)}>
              {formatSignedCurrency(totalRealizedPnl)}
            </span>
          </div>
          <div className="hero-kpi-sub">
            Net realized P&L from {redeemedCount} redeemed positions
          </div>
        </div>

        {/* Card 5: Segregated Brokerage Cash (ONLY when applicable) */}
        {brokerageCash > 0 && (
          <div className="hero-kpi-card cash-card secondary-kpi">
            <div className="hero-kpi-lbl">UNINVESTED BROKERAGE CASH</div>
            <div className="hero-kpi-val cash num-tabular">{formatINR(brokerageCash)}</div>
            <div className="hero-kpi-sub">
              Available cash outside invested positions
            </div>
          </div>
        )}
      </div>

      {/* Auxiliary Status Strip */}
      <div className="portfolio-status-strip">
        <div className="status-strip-pill">
          <span className="status-dot green" />
          <span>Active Schemes: <strong>{activeHoldingsCount}</strong></span>
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

