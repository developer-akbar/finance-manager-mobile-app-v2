import React, { useMemo } from 'react';
import { formatINR, formatINRCompact } from '../../utils/format.js';
import { usePortfolio } from '../../hooks/usePortfolio.js';
import { defaultValuationProvider } from '../../utils/valuationProvider.js';
import {
  aggregatePositionsForDisplay,
  getInvestmentDisplayMetrics,
  formatSignedCurrency,
  formatSignedPercent,
} from '../../utils/portfolioAggregation.js';

export default function DashboardInvestmentSummary({
  transactions = [],
  settings = {},
  showPrivacy,
  onOpenPortfolio,
}) {
  // Authoritative portfolio calculation hook matching Portfolio page personal scope
  const { summaryMetrics, activeHoldings, valuationVersion } = usePortfolio(transactions, settings, {
    scopeFilter: 'personal',
    platformFilter: 'all',
    accountFilter: 'all',
    valuationProvider: defaultValuationProvider,
    autoFetchValuations: false,
  });

  const activeCostBasis = summaryMetrics?.activeCostBasis || 0;
  const totalValuedAmount = summaryMetrics?.totalValuedAmount ?? null;
  const totalRealizedPnl = summaryMetrics?.totalRealizedPnl || 0;
  const valuedUnrealizedPnl = summaryMetrics?.valuedUnrealizedPnl ?? null;
  const valuedReturnPercent = summaryMetrics?.valuedReturnPercent ?? null;
  const xirr = summaryMetrics?.portfolioXirr;
  const hasPartialValuation = summaryMetrics?.hasPartialValuation || false;
  const isFullyValued = summaryMetrics?.isFullyValued || false;
  const valuedCount = summaryMetrics?.valuedCount || 0;
  const totalActiveCount = summaryMetrics?.totalActiveCount || (activeHoldings ? activeHoldings.length : 0);

  // Authoritative asset class breakdown and aggregated top holdings
  const { equity, mutualFunds, topHoldings } = useMemo(() => {
    const eq = { count: 0, cost: 0, value: 0, valuedCount: 0 };
    const mf = { count: 0, cost: 0, value: 0, valuedCount: 0 };

    for (const p of (activeHoldings || [])) {
      const meta = getInvestmentDisplayMetrics(p);
      const isMF = meta.assetType === 'MUTUAL_FUND';
      const cost = p.remainingCostBasis || 0;
      const v = defaultValuationProvider.getValuation(p);
      const isVal = !!(v && v.isValued && typeof v.currentValue === 'number');
      const val = isVal ? v.currentValue : 0;

      if (isMF) {
        mf.count++;
        mf.cost += cost;
        mf.value += val;
        if (isVal) mf.valuedCount++;
      } else {
        eq.count++;
        eq.cost += cost;
        eq.value += val;
        if (isVal) eq.valuedCount++;
      }
    }

    // Authoritative aggregated positions for top holdings preview
    const rawGroups = aggregatePositionsForDisplay(activeHoldings || [], defaultValuationProvider);
    const sorted = [...rawGroups].sort((a, b) => {
      const valA = a.valuation?.isValued ? a.valuation.currentValue : (a.remainingCostBasis || 0);
      const valB = b.valuation?.isValued ? b.valuation.currentValue : (b.remainingCostBasis || 0);
      return valB - valA;
    });

    return {
      equity: {
        count: eq.count,
        cost: Math.round(eq.cost * 100) / 100,
        value: Math.round(eq.value * 100) / 100,
        valuedCount: eq.valuedCount,
      },
      mutualFunds: {
        count: mf.count,
        cost: Math.round(mf.cost * 100) / 100,
        value: Math.round(mf.value * 100) / 100,
        valuedCount: mf.valuedCount,
      },
      topHoldings: sorted.slice(0, 4),
    };
  }, [activeHoldings, valuationVersion]);

  // Proportional split based on invested cost basis (since all holdings have cost basis)
  const totalCost = (equity.cost + mutualFunds.cost) || 1;
  const equityPct = Math.round((equity.cost / totalCost) * 100);
  const mfPct = 100 - equityPct;

  return (
    <div className="dash-bento-card dash-investment-bento-card">
      {/* Header */}
      <div className="dash-card-header-compact">
        <div className="dash-card-title-group">
          <div className="dash-bento-card-title">Investment Portfolio</div>
          <div className="dash-bento-card-sub">
            {totalActiveCount} active holdings · Authoritative valuation
          </div>
        </div>
        <button
          type="button"
          className="dash-card-action-link"
          onClick={onOpenPortfolio}
        >
          View Portfolio →
        </button>
      </div>

      <div className="dash-inv-body">
        {/* ── ROW 1: CURRENT VALUE & AUTHORITATIVE PNL MATRIX ── */}
        <div className="dash-inv-hero-row">
          <div className="dash-inv-main-stat">
            <span className="dash-inv-lbl">Current Portfolio Value</span>
            <div className="dash-inv-val">
              {showPrivacy ? (
                totalValuedAmount !== null ? formatINR(totalValuedAmount) : 'NAV / LTP unavailable'
              ) : '₹ ••••••'}
            </div>
            <div className="dash-inv-sub">
              Invested: <strong>{showPrivacy ? formatINR(activeCostBasis) : '••••'}</strong>
              <span className="dash-inv-coverage-pill" title="Valuation coverage across active holdings">
                {isFullyValued ? '100% Valued' : `${valuedCount} of ${totalActiveCount} valued`}
              </span>
              {totalActiveCount > valuedCount && (
                <span className="dash-inv-unvalued-note">
                  ({totalActiveCount - valuedCount} held at cost)
                </span>
              )}
            </div>
          </div>

          <div className="dash-inv-pnl-matrix">
            {/* Unrealized P&L with percentage placed immediately below its rupee amount */}
            <div className="dash-inv-pnl-pill" title="Unrealized profit/loss on live-valued holdings">
              <div className="dash-pnl-left">
                <span className="dash-pnl-lbl">Unrealized P&L</span>
                <span className="dash-pnl-caption">
                  {hasPartialValuation ? `(${valuedCount} valued)` : 'Awaiting prices'}
                </span>
              </div>
              <div className="dash-pnl-right-stacked">
                <span className={`dash-pnl-num ${valuedUnrealizedPnl >= 0 ? 'positive' : 'negative'}`}>
                  {valuedUnrealizedPnl !== null ? (
                    `${valuedUnrealizedPnl >= 0 ? '+' : ''}${showPrivacy ? formatINR(valuedUnrealizedPnl) : '••••'}`
                  ) : '—'}
                </span>
                {valuedReturnPercent !== null && (
                  <span className={`dash-pnl-sub-pct ${valuedReturnPercent >= 0 ? 'positive' : 'negative'}`}>
                    {valuedReturnPercent >= 0 ? '+' : ''}{valuedReturnPercent}% return
                  </span>
                )}
              </div>
            </div>

            {/* All-Time Realized P&L */}
            <div className="dash-inv-pnl-pill" title="Cumulative realized profit/loss booked from closed sales">
              <div className="dash-pnl-left">
                <span className="dash-pnl-lbl">All-Time Realized</span>
                <span className="dash-pnl-caption">Booked gains</span>
              </div>
              <span className={`dash-pnl-num ${totalRealizedPnl >= 0 ? 'positive' : 'negative'}`}>
                {totalRealizedPnl >= 0 ? '+' : ''}{showPrivacy ? formatINR(totalRealizedPnl) : '••••'}
              </span>
            </div>

            {/* Portfolio XIRR */}
            {xirr !== null && xirr !== undefined && (
              <div className="dash-inv-pnl-pill" title="Annualized internal rate of return">
                <div className="dash-pnl-left">
                  <span className="dash-pnl-lbl">Portfolio XIRR</span>
                  <span className="dash-pnl-caption">Annualized</span>
                </div>
                <span className={`dash-pnl-num ${xirr >= 0 ? 'positive' : 'negative'}`}>
                  {xirr >= 0 ? '+' : ''}{xirr.toFixed(1)}%
                </span>
              </div>
            )}
          </div>
        </div>

        {/* ── ROW 2: ASSET CLASS CARDS (EQUITY VS MUTUAL FUNDS) ── */}
        <div className="dash-inv-assets-grid">
          {/* Equity Card */}
          <div className="dash-inv-asset-card equity">
            <div className="dash-inv-asset-top">
              <div className="dash-inv-asset-name">
                <span className="dash-asset-bullet" style={{ background: '#0075FF' }} />
                <span>Stocks & Equity</span>
                <span className="dash-asset-count">{equity.count}</span>
              </div>
              <span className="dash-inv-badge ltp">
                {equity.valuedCount > 0 ? `${equity.valuedCount}/${equity.count} Valued` : 'Cost Basis'}
              </span>
            </div>
            <div className="dash-inv-asset-nums">
              <div className="dash-inv-asset-val">
                {showPrivacy ? (equity.value > 0 ? formatINR(equity.value) : formatINR(equity.cost)) : '••••'}
              </div>
              <div className="dash-inv-asset-sub">
                Invested: <strong>{showPrivacy ? formatINRCompact(equity.cost) : '••••'}</strong>
                {equity.value > 0 && equity.cost > 0 && (
                  <span className={`dash-asset-pnl ${equity.value >= equity.cost ? 'positive' : 'negative'}`}>
                    {equity.value >= equity.cost ? '+' : ''}{formatINRCompact(equity.value - equity.cost)}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Mutual Funds Card */}
          <div className="dash-inv-asset-card mf">
            <div className="dash-inv-asset-top">
              <div className="dash-inv-asset-name">
                <span className="dash-asset-bullet" style={{ background: '#00D2D3' }} />
                <span>Mutual Funds</span>
                <span className="dash-asset-count">{mutualFunds.count}</span>
              </div>
              <span className="dash-inv-badge cost" title="Holdings valuation status">
                {mutualFunds.valuedCount > 0 ? `${mutualFunds.valuedCount}/${mutualFunds.count} Valued` : 'At Cost Basis'}
              </span>
            </div>
            <div className="dash-inv-asset-nums">
              <div className="dash-inv-asset-val">
                {showPrivacy ? (mutualFunds.value > 0 ? formatINR(mutualFunds.value) : formatINR(mutualFunds.cost)) : '••••'}
              </div>
              <div className="dash-inv-asset-sub">
                Invested: <strong>{showPrivacy ? formatINRCompact(mutualFunds.cost) : '••••'}</strong>
                {mutualFunds.value > 0 && mutualFunds.cost > 0 ? (
                  <span className={`dash-asset-pnl ${mutualFunds.value >= mutualFunds.cost ? 'positive' : 'negative'}`}>
                    {mutualFunds.value >= mutualFunds.cost ? '+' : ''}{formatINRCompact(mutualFunds.value - mutualFunds.cost)}
                  </span>
                ) : (
                  <span className="dash-asset-pnl neutral">NAV Awaiting Sync</span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── ROW 3: ALLOCATION BAR & LEGEND ── */}
        {totalCost > 0 && (
          <div className="dash-inv-alloc-wrap">
            <div className="dash-inv-alloc-hdr">
              <span>Asset Allocation (Invested Basis)</span>
              <span>{equityPct}% Equity · {mfPct}% Mutual Funds</span>
            </div>
            <div className="dash-inv-alloc-bar">
              <div
                className="dash-alloc-segment equity"
                style={{ width: `${equityPct}%` }}
                title={`Equity: ${equityPct}% (${showPrivacy ? formatINR(equity.cost) : ''})`}
              />
              <div
                className="dash-alloc-segment mf"
                style={{ width: `${mfPct}%` }}
                title={`Mutual Funds: ${mfPct}% (${showPrivacy ? formatINR(mutualFunds.cost) : ''})`}
              />
            </div>
            <div className="dash-inv-alloc-legend">
              <div className="dash-alloc-leg-item">
                <span className="dash-alloc-dot" style={{ background: '#0075FF' }} />
                <span>Stocks ({showPrivacy ? formatINRCompact(equity.cost) : '••••'})</span>
              </div>
              <div className="dash-alloc-leg-item">
                <span className="dash-alloc-dot" style={{ background: '#00D2D3' }} />
                <span>Mutual Funds ({showPrivacy ? formatINRCompact(mutualFunds.cost) : '••••'})</span>
              </div>
            </div>
          </div>
        )}

        {/* ── ROW 4: TOP HOLDINGS PREVIEW WITH AUTHORITATIVE DATA ── */}
        {topHoldings.length > 0 && (
          <div className="dash-inv-holdings-preview">
            <div className="dash-inv-preview-hdr">
              <span>Top Holdings</span>
              <span className="dash-inv-preview-sub">Invested · Current · Gain/Loss</span>
            </div>
            <div className="dash-inv-preview-list">
              {topHoldings.map((h) => {
                const displayName = h.note || h.security || 'Investment';
                const isVal = !!(h.valuation && h.valuation.isValued);
                const currentVal = isVal ? h.valuation.currentValue : null;
                const costVal = h.remainingCostBasis || 0;
                const pnl = isVal ? h.valuation.unrealizedPnl : null;
                const pnlPct = isVal ? h.valuation.returnPercent : null;

                return (
                  <div key={h.groupKey || displayName} className="dash-inv-preview-item">
                    <div className="dash-inv-item-info">
                      <div className="dash-inv-item-title-row">
                        <span className="dash-inv-item-name" title={displayName}>{displayName}</span>
                        {isVal ? (
                          <span className="dash-inv-source-pill ltp" title="Valued with live price / NAV">
                            Live NAV
                          </span>
                        ) : (
                          <span className="dash-inv-source-pill cost" title="Valued at invested cost basis pending live NAV sync">
                            Cost Basis
                          </span>
                        )}
                      </div>
                      <div className="dash-inv-item-sub">
                        <span>Invested: <strong>{showPrivacy ? formatINR(costVal) : '••••'}</strong></span>
                        {currentVal !== null && (
                          <span> · Current: <strong>{showPrivacy ? formatINR(currentVal) : '••••'}</strong></span>
                        )}
                      </div>
                    </div>

                    <div className="dash-inv-item-right">
                      {isVal && pnl !== null ? (
                        <div className="dash-inv-holding-pnl-wrap">
                          <span className={`dash-inv-holding-pnl ${pnl >= 0 ? 'positive' : 'negative'}`}>
                            {formatSignedCurrency(pnl)}
                          </span>
                          <span className={`dash-inv-holding-pnl-pct ${pnlPct >= 0 ? 'positive' : 'negative'}`}>
                            {formatSignedPercent(pnlPct)}
                          </span>
                        </div>
                      ) : (
                        <span className="dash-inv-source-pill cost">Awaiting NAV</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
