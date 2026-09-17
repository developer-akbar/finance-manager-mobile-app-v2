import React, { useState, useMemo } from 'react';
import { formatINR } from '../../../utils/format.js';
import { defaultValuationProvider, detectAssetType } from '../../../utils/valuationProvider.js';
import { parseTxnFields } from '../../../utils/brokerageAccounting.js';
import { 
  getInvestmentDisplayMetrics, 
  formatAsOfDate, 
  formatSignedCurrency, 
  formatSignedPercent,
  getPnlClass,
  computePositionXIRR,
  getTodaysChange
} from '../../../utils/portfolioAggregation.js';

function extractTxnDetails(t, isMf) {
  if (!t) return { isBuy: true, actionLbl: 'BOUGHT', parsedUnits: 0, parsedPrice: 0, parsedVal: 0, date: '' };
  
  const f = parseTxnFields(t);
  
  const rawType = String(
    f?.type || 
    t.action || 
    t.InvestmentTransactionType || 
    t.investment_transaction_type || 
    t.type || 
    ''
  ).toUpperCase();
  
  const isBuy = rawType.includes('BUY') || rawType.includes('INVEST') || rawType === 'OPENING_LOT';
  const actionLbl = isMf ? (isBuy ? 'INVESTED' : 'REDEEMED') : (isBuy ? 'BOUGHT' : 'SOLD');

  let parsedUnits = 0;
  if (f && f.qty > 0) {
    parsedUnits = f.qty;
  } else {
    const qVal = t.units ?? t.Units ?? t.quantity ?? t.Quantity ?? t.PositionQuantityChange ?? t.sellUnits ?? t.buyUnits ?? 0;
    parsedUnits = Math.abs(parseFloat(qVal) || 0);
  }

  let parsedPrice = 0;
  if (t.unitPrice !== undefined && t.unitPrice !== null && t.unitPrice !== '') {
    parsedPrice = parseFloat(t.unitPrice) || 0;
  } else if (t.UnitPrice !== undefined && t.UnitPrice !== null && t.UnitPrice !== '') {
    parsedPrice = parseFloat(t.UnitPrice) || 0;
  } else if (t.price !== undefined && t.price !== null && t.price !== '') {
    parsedPrice = parseFloat(t.price) || 0;
  } else if (f && f.cost > 0 && f.qty > 0) {
    parsedPrice = f.cost / f.qty;
  }

  let parsedVal = 0;
  if (f && (f.cost > 0 || f.cashImpact > 0)) {
    parsedVal = f.cost || f.cashImpact;
  } else {
    const valCandidates = [t.tradeValue, t.TradeValue, t.costBasis, t.CostBasis, t.cashImpact, t.INR, t.inr, t.Amount, t.amount];
    for (const cand of valCandidates) {
      if (cand !== undefined && cand !== null && cand !== '') {
        const p = Math.abs(parseFloat(cand));
        if (!isNaN(p) && p > 0) {
          parsedVal = p;
          break;
        }
      }
    }
  }

  if (parsedPrice === 0 && parsedVal > 0 && parsedUnits > 0) {
    parsedPrice = parsedVal / parsedUnits;
  }
  if (parsedVal === 0 && parsedPrice > 0 && parsedUnits > 0) {
    parsedVal = parsedPrice * parsedUnits;
  }

  const date = t.date || t.Date || t.firstBuyDate || '';

  return {
    isBuy,
    actionLbl,
    parsedUnits,
    parsedPrice,
    parsedVal,
    date
  };
}

export default function HoldingDetailSheet({ 
  position, 
  valuationProvider, 
  valuationVersion, 
  valuation, 
  oneDayDisplayMode = 'unit',
  onToggleOneDayDisplayMode = null,
  onClose, 
  onSelectTxn 
}) {
  if (!position) return null;

  const provider = valuationProvider || (valuation && typeof valuation.getValuation === 'function' ? valuation : defaultValuationProvider);

  const isAggregated = position.isAggregateGroup && Array.isArray(position.underlyingPositions) && position.underlyingPositions.length > 1;
  const underlyingPositions = isAggregated ? position.underlyingPositions : [position];

  const [selectedFolioKey, setSelectedFolioKey] = useState('all');
  const [activeTab, setActiveTab] = useState('txns'); // 'txns' | 'fifo' | 'accounting' (for tablet & mobile)

  const isViewingAll = selectedFolioKey === 'all' || !isAggregated;
  const activeFolioPos = isViewingAll 
    ? null 
    : underlyingPositions[parseInt(selectedFolioKey, 10)];

  const displayPos = activeFolioPos || position;
  const activeValuation = provider ? provider.getValuation(displayPos) : displayPos.valuation;
  const isValued = activeValuation && activeValuation.isValued;
  const metrics = getInvestmentDisplayMetrics(displayPos, activeValuation);

  const displayTxns = useMemo(() => {
    if (isViewingAll) {
      if (Array.isArray(position.txns) && position.txns.length > 0) {
        return position.txns;
      }
      return underlyingPositions.flatMap(p => p.txns || p.transactions || p.allTransactions || []);
    }
    return activeFolioPos?.txns || activeFolioPos?.transactions || activeFolioPos?.allTransactions || [];
  }, [isViewingAll, position, underlyingPositions, activeFolioPos]);

  const displayLots = useMemo(() => {
    let lots = [];
    if (isViewingAll) {
      if (Array.isArray(position.buyLots) && position.buyLots.length > 0) {
        lots = position.buyLots;
      } else {
        lots = underlyingPositions.flatMap(p => p.buyLots || p.fifoLots || []);
      }
    } else {
      lots = activeFolioPos?.buyLots || activeFolioPos?.fifoLots || [];
    }

    // DISPLAY ORDER ONLY: Latest acquisition date first (descending).
    // Underlying FIFO calculation and order remains chronological oldest -> newest.
    return [...lots].sort((a, b) => {
      const parseD = (str) => {
        if (!str) return 0;
        const pts = String(str).split(/[-/]/);
        if (pts.length === 3) {
          if (pts[0].length === 4) return new Date(pts[0], pts[1] - 1, pts[2]).getTime();
          return new Date(pts[2], pts[1] - 1, pts[0]).getTime();
        }
        return new Date(str || 0).getTime() || 0;
      };
      return parseD(b.date || b.Date) - parseD(a.date || a.Date);
    });
  }, [isViewingAll, position, underlyingPositions, activeFolioPos]);

  const sortedTxns = useMemo(() => {
    return [...displayTxns].sort((a, b) => {
      const parseD = (str) => {
        if (!str) return 0;
        const pts = String(str).split(/[-/]/);
        if (pts.length === 3) {
          if (pts[0].length === 4) return new Date(pts[0], pts[1] - 1, pts[2]).getTime();
          return new Date(pts[2], pts[1] - 1, pts[0]).getTime();
        }
        return new Date(str || 0).getTime() || 0;
      };
      return parseD(b.date || b.Date) - parseD(a.date || a.Date);
    });
  }, [displayTxns]);

  const ageInfo = useMemo(() => {
    if (!sortedTxns || sortedTxns.length === 0) return { fullStr: '' };
    
    const parseD = (str) => {
      if (!str) return null;
      const pts = String(str).split(/[-/]/);
      if (pts.length === 3) {
        if (pts[0].length === 4) return new Date(parseInt(pts[0], 10), parseInt(pts[1], 10) - 1, parseInt(pts[2], 10));
        return new Date(parseInt(pts[2], 10), parseInt(pts[1], 10) - 1, parseInt(pts[0], 10));
      }
      return new Date(str);
    };

    const dates = sortedTxns.map(t => parseD(t.date || t.Date)).filter(d => d && !isNaN(d.getTime())).sort((a, b) => a - b);
    if (dates.length === 0) return { fullStr: '' };

    const startD = dates[0];
    const isRedeemed = displayPos.status === 'REDEEMED';
    const endD = isRedeemed ? dates[dates.length - 1] : new Date('2026-09-06');
    
    if (isRedeemed && startD.getFullYear() === endD.getFullYear() && startD.getMonth() === endD.getMonth() && startD.getDate() === endD.getDate()) {
      return { fullStr: 'Held: Same day' };
    }

    let years = endD.getFullYear() - startD.getFullYear();
    let months = endD.getMonth() - startD.getMonth();
    if (months < 0) {
      years -= 1;
      months += 12;
    }
    if (endD.getDate() < startD.getDate()) {
      months -= 1;
      if (months < 0) {
        years -= 1;
        months += 12;
      }
    }

    const partsArr = [];
    if (years > 0) partsArr.push(`${years} ${years === 1 ? 'year' : 'years'}`);
    if (months > 0 || years === 0) partsArr.push(`${months} ${months === 1 ? 'month' : 'months'}`);
    
    const prefix = isRedeemed ? 'Held for' : 'Invested for';
    return { fullStr: `${prefix} ${partsArr.join(' ')}` };
  }, [sortedTxns, displayPos.status]);

  const exitedUnits = displayPos.sellUnits || displayPos.buyUnits || displayPos.exitedQty || 0;
  const isRedeemed = displayPos.status === 'REDEEMED';

  const avgBuyPriceStr = useMemo(() => {
    if (isRedeemed) {
      const totalCost = displayPos.buyCost || displayPos.soldCostBasis || 0;
      if (totalCost > 0 && exitedUnits > 0) {
        return `₹${(totalCost / exitedUnits).toFixed(2)}`;
      }
      return '—';
    }
    return metrics.formattedAvgPrice ? metrics.formattedAvgPrice.replace(/^(Avg NAV|Avg Price)\s*/, '') : '—';
  }, [isRedeemed, displayPos, exitedUnits, metrics.formattedAvgPrice]);

  const assetType = detectAssetType(displayPos);
  const dailyChange = !isRedeemed && isValued && typeof activeValuation?.nav === 'number'
    ? getTodaysChange(activeValuation.nav, activeValuation.previousClose, assetType, displayPos.currentUnits, oneDayDisplayMode)
    : null;

  const detailXirr = computePositionXIRR(displayPos, activeValuation);

  // Render Transaction History Table Component
  const renderTxnTable = (isDesktopPanel = false) => {
    if (sortedTxns.length === 0) {
      return (
        <div className="portfolio-empty-state font-xs text-muted">
          No transactions recorded for this view.
        </div>
      );
    }
    return (
      <div className={`sheet-lots-table-wrap ${isDesktopPanel ? 'desktop-panel-table-wrap' : ''}`}>
        <table className="sheet-lots-table groww-txn-table detail-txn-table">
          <thead>
            <tr>
              <th>Action</th>
              <th>Date</th>
              <th style={{ textAlign: 'right' }}>{metrics.qtyLabel}</th>
              <th style={{ textAlign: 'right' }}>{metrics.priceLabel}</th>
              <th style={{ textAlign: 'right' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {sortedTxns.map((t, idx) => {
              const txnInfo = extractTxnDetails(t, metrics.isMf);
              const isBuy = txnInfo.isBuy;
              const actionLbl = txnInfo.actionLbl;

              const formattedUnitsStr = metrics.isMf 
                ? txnInfo.parsedUnits.toFixed(3) 
                : `${Math.round(txnInfo.parsedUnits)} shares`;

              const priceStr = txnInfo.parsedPrice > 0 ? `₹${txnInfo.parsedPrice.toFixed(2)}` : '—';
              const tradeValStr = formatINR(txnInfo.parsedVal);

              const isPosAmount = metrics.isMf ? isBuy : !isBuy;
              const amountSign = metrics.isMf ? '+' : (isBuy ? '-' : '+');
              const pnlClass = isPosAmount ? 'pos' : 'neg';

              return (
                <tr key={t.rawTxn?.ID || t.id || idx}>
                  <td>
                    <span className={`txn-type-pill ${isBuy ? 'buy' : 'sell'}`}>
                      {actionLbl}
                    </span>
                  </td>
                  <td className="num-tabular mono font-semibold">{txnInfo.date}</td>
                  <td style={{ textAlign: 'right' }} className={`mono font-bold num-tabular ${isBuy ? 'pos' : 'neg'}`}>
                    {isBuy ? '+' : '-'}{formattedUnitsStr}
                  </td>
                  <td style={{ textAlign: 'right' }} className="mono text-muted num-tabular font-semibold">
                    {priceStr}
                  </td>
                  <td style={{ textAlign: 'right' }} className={`font-bold num-tabular ${pnlClass}`}>
                    {amountSign}{tradeValStr}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  // Render FIFO Lots Table Component
  const renderFifoTable = (isDesktopPanel = false) => {
    if (displayLots.length === 0) {
      return (
        <div className="portfolio-empty-state font-xs text-muted">
          No active FIFO lots for this view.
        </div>
      );
    }
    return (
      <div className={`sheet-lots-table-wrap ${isDesktopPanel ? 'desktop-panel-table-wrap' : ''}`}>
        <table className="sheet-lots-table fifo-table detail-fifo-table">
          <thead>
            <tr>
              <th>Acquired</th>
              <th style={{ textAlign: 'right' }}>Acq Qty</th>
              <th style={{ textAlign: 'right' }}>Rem Qty</th>
              <th style={{ textAlign: 'right' }}>{metrics.isMf ? 'NAV' : 'Price'}</th>
              <th style={{ textAlign: 'right' }}>Rem Cost</th>
            </tr>
          </thead>
          <tbody>
            {displayLots.map((lot, idx) => {
              const origUnits = lot.units !== undefined ? lot.units : (lot.qty || lot.quantity || 0);
              const remUnits = lot.remainingUnits !== undefined ? lot.remainingUnits : 0;
              const uCost = lot.unitCost !== undefined ? lot.unitCost : (origUnits > 0 ? lot.costBasis / origUnits : 0);

              return (
                <tr key={lot.transactionId || idx}>
                  <td className="num-tabular mono font-semibold">{lot.date}</td>
                  <td style={{ textAlign: 'right' }} className="num-tabular mono text-muted">
                    {metrics.isMf ? origUnits.toFixed(3) : Math.round(origUnits)}
                  </td>
                  <td style={{ textAlign: 'right' }} className={`num-tabular mono font-bold ${remUnits > 0 ? 'pos' : 'text-muted'}`}>
                    {metrics.isMf ? remUnits.toFixed(3) : Math.round(remUnits)}
                  </td>
                  <td style={{ textAlign: 'right' }} className="num-tabular mono font-semibold">₹{uCost.toFixed(metrics.isMf ? 2 : 2)}</td>
                  <td style={{ textAlign: 'right' }} className="num-tabular font-bold text-primary">
                    {formatINR(lot.remainingCostBasis !== undefined ? lot.remainingCostBasis : (remUnits * uCost))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  // Render Accounting Key-Values Component
  const renderAccountingContent = () => {
    return (
      <div className="sheet-grid-2 detail-accounting-grid">
        <div className="sheet-detail-row">
          <span className="sec-lbl text-muted uppercase">PLATFORM / SUBACCOUNT</span>
          <span className="sec-val font-semibold text-primary">{displayPos.subAccount}</span>
        </div>
        <div className="sheet-detail-row">
          <span className="sec-lbl text-muted uppercase">INVESTMENT ACCOUNT</span>
          <span className="sec-val font-semibold text-primary">{displayPos.investmentAccount}</span>
        </div>
        <div className="sheet-detail-row">
          <span className="sec-lbl text-muted uppercase">ISIN</span>
          <span className="sec-val font-semibold mono text-primary">{displayPos.isin || '—'}</span>
        </div>
        <div className="sheet-detail-row">
          <span className="sec-lbl text-muted uppercase">FOLIO NUMBER</span>
          <span className="sec-val font-semibold mono text-primary">{displayPos.folioNumber || 'Single Folio'}</span>
        </div>
        <div className="sheet-detail-row">
          <span className="sec-lbl text-muted uppercase">HOLDING MODE</span>
          <span className="sec-val font-semibold text-primary">{displayPos.holdingMode || 'PHYSICAL/SOA'}</span>
        </div>
        <div className="sheet-detail-row">
          <span className="sec-lbl text-muted uppercase">OWNERSHIP SCOPE</span>
          <span className="sec-val font-semibold text-primary">{displayPos.ownershipTag === 'MIXED_HOLDING' ? 'Mixed Holding' : (displayPos.ownershipTag || 'Individual')}</span>
        </div>
        <div className="sheet-detail-row">
          <span className="sec-lbl text-muted uppercase">REALIZED P&L</span>
          <span className="sec-val num-tabular font-bold">
            {displayPos.realizedPnl !== 0 ? (
              <span className={displayPos.realizedPnl > 0 ? 'pos' : 'neg'}>
                {displayPos.realizedPnl > 0 ? '+' : ''}{formatINR(displayPos.realizedPnl)}
              </span>
            ) : '₹0.00'}
          </span>
        </div>
        <div className="sheet-detail-row">
          <span className="sec-lbl text-muted uppercase">ACCOUNTING METHOD</span>
          <span className="sec-val font-semibold text-primary">First-In, First-Out (FIFO)</span>
        </div>
        <div className="sheet-detail-row">
          <span className="sec-lbl text-muted uppercase">TOTAL TRANSACTIONS</span>
          <span className="sec-val font-semibold mono text-primary">{sortedTxns.length}</span>
        </div>
        <div className="sheet-detail-row">
          <span className="sec-lbl text-muted uppercase">ACTIVE FIFO LOTS</span>
          <span className="sec-val font-semibold mono text-primary">{displayLots.filter(l => (l.remainingUnits || 0) > 0).length}</span>
        </div>
      </div>
    );
  };

  return (
    <div className="investments-portfolio-screen fund-detail-fullpage">
      {/* 1. Header Bar */}
      <div className="portfolio-top-bar">
        <button className="portfolio-back-btn" onClick={onClose} title="Back to Portfolio">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="20" height="20">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="portfolio-top-titles" style={{ minWidth: 0, flex: 1 }}>
          <h2 className="portfolio-main-title holding-card-name" title={position.note || position.security}>
            {position.note || position.security}
          </h2>
          <div className="portfolio-header-chips flex-gap-xs align-center mt-1">
            {ageInfo.fullStr && <span className="age-text text-muted font-xs">{ageInfo.fullStr}</span>}
            <span className="platform-tag">{displayPos.subAccount || position.subAccount}</span>
            {position.folioNumber && <span className="platform-tag mono">Folio: {position.folioNumber}</span>}
            {(displayPos.ownershipTag === 'MIXED_HOLDING' || position.ownershipTag === 'MIXED_HOLDING') && (
              <span className="platform-tag mixed-tag">Mixed Holding</span>
            )}
            {isRedeemed ? (
              <span className="coverage-badge gray">Closed / Redeemed</span>
            ) : (
              <span className="coverage-badge green">Active Position</span>
            )}
          </div>
        </div>
      </div>

      <div className="portfolio-scrollable-content detail-scrollable-content">
        {/* 2. Top Cards Grid: Side-by-Side Hero (Performance) + Lifecycle (Metadata) on Desktop/Tablet */}
        <div className="detail-top-cards-grid mb-2.5">
          {/* Card A: Financial Performance Hero (Compact 2-Column Grouped KPI Grid) */}
          <div className="portfolio-card detail-hero-card">
            <div className="portfolio-card-header mb-2 flex-between align-center">
              <h4 className="portfolio-card-title detail-card-heading">PERFORMANCE OVERVIEW</h4>
              {isValued && activeValuation?.asOf && !isRedeemed && (
                <span className="detail-as-of-meta text-muted">
                  As of {formatAsOfDate(activeValuation.asOf)}{activeValuation?.asOfTime ? `, ${activeValuation.asOfTime}` : ''}
                </span>
              )}
            </div>
            <div className="detail-hero-grid">
              {/* Column 1: Value & Cost Group */}
              <div className="detail-hero-col">
                {/* Cell 1A: CURRENT VALUE */}
                <div className="detail-kpi-cell">
                  <span className="detail-metric-lbl text-muted uppercase">CURRENT VALUE</span>
                  <div className={`detail-metric-val font-bold num-tabular mt-0.5 ${isRedeemed ? 'text-muted' : 'text-primary'}`}>
                    {isRedeemed ? '₹0 (Closed)' : (isValued ? formatINR(activeValuation.currentValue) : <span className="val-na text-muted">{metrics.unvaluedLabel}</span>)}
                  </div>
                  {dailyChange && !isRedeemed && (
                    <div 
                      className={`todays-change font-semibold num-tabular mt-0.5 ${dailyChange.cls}`}
                      style={{ fontSize: '0.74rem', color: dailyChange.color, cursor: 'pointer' }}
                      title="Tap 1D change to toggle price vs position P&L"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (onToggleOneDayDisplayMode) onToggleOneDayDisplayMode(e);
                      }}
                    >
                      1D: {dailyChange.text}
                    </div>
                  )}
                </div>

                {/* Cell 1B: INVESTED / COST BASIS */}
                <div className="detail-kpi-cell mt-2.5">
                  <span className="detail-metric-lbl text-muted uppercase">{isRedeemed ? 'COST BASIS' : 'INVESTED'}</span>
                  <div className="detail-metric-val secondary font-bold num-tabular mt-0.5 text-primary">
                    {formatINR(isRedeemed ? (displayPos.buyCost || displayPos.soldCostBasis || displayPos.remainingCostBasis) : displayPos.remainingCostBasis)}
                  </div>
                  <div className="detail-metric-sub text-muted font-xs mt-0.5">
                    {displayLots.length} acquisition {displayLots.length === 1 ? 'lot' : 'lots'}
                  </div>
                </div>
              </div>

              {/* Column 2: Returns & XIRR Group */}
              <div className="detail-hero-col">
                {/* Cell 2A: TOTAL P&L / REALIZED P&L */}
                <div className="detail-kpi-cell">
                  <span className="detail-metric-lbl text-muted uppercase">{isRedeemed ? 'REALIZED P&L' : 'TOTAL P&L'}</span>
                  {isRedeemed ? (
                    <div className={`detail-metric-val font-bold num-tabular mt-0.5 ${getPnlClass(displayPos.realizedPnl)}`}>
                      {formatSignedCurrency(displayPos.realizedPnl)}
                    </div>
                  ) : isValued ? (
                    <div className={`detail-metric-val font-bold num-tabular mt-0.5 ${getPnlClass(activeValuation.unrealizedPnl)}`}>
                      {formatSignedCurrency(activeValuation.unrealizedPnl)}
                      <span className="pnl-pct-badge font-semibold ml-1">
                        ({formatSignedPercent(activeValuation.returnPercent)})
                      </span>
                    </div>
                  ) : (
                    <div className="detail-metric-val text-muted mt-0.5">—</div>
                  )}
                  {!isRedeemed && displayPos.realizedPnl !== 0 && (
                    <div className="detail-metric-sub text-muted font-xs mt-0.5 num-tabular">
                      Realized: <span className={getPnlClass(displayPos.realizedPnl)}>{formatSignedCurrency(displayPos.realizedPnl)}</span>
                    </div>
                  )}
                </div>

                {/* Cell 2B: ANNUALIZED (XIRR) */}
                <div className="detail-kpi-cell mt-2.5">
                  <span className="detail-metric-lbl text-muted uppercase">ANNUALIZED (XIRR)</span>
                  <div className="detail-metric-val secondary font-bold num-tabular mt-0.5">
                    {detailXirr !== null ? (
                      <span className={getPnlClass(detailXirr)}>
                        {formatSignedPercent(detailXirr)}
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </div>
                  <div className="detail-metric-sub text-muted font-xs mt-0.5">
                    Cashflow IRR
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Card B: Position Lifecycle & Security Metadata (Compact 3-Column Info Panel) */}
          <div className="portfolio-card detail-lifecycle-card">
            <div className="portfolio-card-header mb-2 flex-between align-center">
              <h4 className="portfolio-card-title detail-card-heading">POSITION LIFECYCLE & SPECS</h4>
              <span className="detail-as-of-meta text-muted mono">{displayPos.isin || 'ID'}</span>
            </div>
            <div className="detail-lifecycle-grid">
              {/* Cell 1: Acquired Date */}
              <div className="lifecycle-cell">
                <span className="lifecycle-lbl text-muted uppercase">ACQUIRED DATE</span>
                <span className="lifecycle-val font-semibold mono text-primary">
                  {displayPos.firstBuyDate || '—'}
                </span>
              </div>

              {/* Cell 2: Exit Date / Status */}
              <div className="lifecycle-cell">
                <span className="lifecycle-lbl text-muted uppercase">{isRedeemed ? 'EXIT DATE' : 'STATUS'}</span>
                <span className="lifecycle-val font-semibold mono text-primary">
                  {isRedeemed ? (displayPos.exitDate || displayPos.lastTransactionDate || '—') : 'Active Holding'}
                </span>
              </div>

              {/* Cell 3: Total Units / Qty */}
              <div className="lifecycle-cell">
                <span className="lifecycle-lbl text-muted uppercase">{isRedeemed ? 'QTY EXITED' : metrics.qtyLabel}</span>
                <span className="lifecycle-val font-semibold mono num-tabular text-primary">
                  {isRedeemed ? (
                    (displayPos.investmentAccount === 'Share Market' || displayPos.holdingMode === 'DEMAT')
                      ? `${Math.round(exitedUnits)} shares`
                      : `${exitedUnits.toFixed(3)} units`
                  ) : (
                    metrics.rawQty || metrics.formattedQty
                  )}
                </span>
              </div>

              {/* Cell 4: Avg Price / NAV */}
              <div className="lifecycle-cell">
                <span className="lifecycle-lbl text-muted uppercase">{isRedeemed ? 'AVG ACQ NAV' : metrics.avgPriceLabel}</span>
                <span className="lifecycle-val font-semibold mono num-tabular text-primary">
                  {avgBuyPriceStr}
                </span>
              </div>

              {/* Cell 5: Platform */}
              <div className="lifecycle-cell">
                <span className="lifecycle-lbl text-muted uppercase">PLATFORM</span>
                <span className="lifecycle-val font-semibold text-primary">
                  {displayPos.subAccount || position.subAccount}
                </span>
              </div>

              {/* Cell 6: Folio / Mode */}
              <div className="lifecycle-cell">
                <span className="lifecycle-lbl text-muted uppercase">FOLIO / MODE</span>
                <span className="lifecycle-val font-semibold mono text-primary">
                  {displayPos.folioNumber || position.folioNumber || displayPos.holdingMode || '—'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* 3. Folios Filter Section (if aggregated / multiple folios) */}
        {isAggregated && (
          <div className="portfolio-card detail-folios-card mb-2.5">
            <div className="portfolio-card-header flex-between mb-2">
              <h4 className="portfolio-card-title font-xs text-muted uppercase">
                UNDERLYING FOLIOS ({underlyingPositions.length})
              </h4>
              <span className="font-xs text-muted">Select a folio to inspect tranches</span>
            </div>

            <div className="portfolio-pill-selector folio-pills-bar mb-2.5">
              <button
                className={`portfolio-pill ${selectedFolioKey === 'all' ? 'active' : ''}`}
                onClick={() => setSelectedFolioKey('all')}
              >
                All Folios ({formatINR(position.remainingCostBasis)})
              </button>
              {underlyingPositions.map((p, idx) => (
                <button
                  key={p.positionKey || idx}
                  className={`portfolio-pill ${selectedFolioKey === String(idx) ? 'active' : ''}`}
                  onClick={() => setSelectedFolioKey(String(idx))}
                >
                  Folio {p.folioNumber} ({p.subAccount})
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 4A. DESKTOP & TABLET ADAPTIVE GRID (>=768px): All 3 Panels Visible Simultaneously */}
        <div className="detail-panels-adaptive-grid mb-3">
          {/* Panel 1: Transaction History */}
          <div className="portfolio-card detail-panel panel-txns">
            <div className="detail-panel-header">
              <div className="flex-between align-center">
                <h3 className="detail-panel-title">
                  Transaction History
                  <span className="count-badge ml-1.5">{sortedTxns.length}</span>
                </h3>
              </div>
              <p className="detail-panel-subtitle text-muted font-xs">All buy, sell, and redemption transactions</p>
            </div>
            <div className="detail-panel-body">
              {renderTxnTable(true)}
            </div>
          </div>

          {/* Panel 2: FIFO Lots */}
          <div className="portfolio-card detail-panel panel-fifo">
            <div className="detail-panel-header">
              <div className="flex-between align-center">
                <h3 className="detail-panel-title">
                  FIFO Lots
                  <span className="count-badge ml-1.5">{displayLots.length}</span>
                </h3>
              </div>
              <p className="detail-panel-subtitle text-muted font-xs">Chronological acquisition tranches</p>
            </div>
            <div className="detail-panel-body">
              {renderFifoTable(true)}
            </div>
          </div>

          {/* Panel 3: Accounting & Audit */}
          <div className="portfolio-card detail-panel panel-accounting">
            <div className="detail-panel-header">
              <h3 className="detail-panel-title">Accounting & Audit</h3>
              <p className="detail-panel-subtitle text-muted font-xs">Portfolio metadata and tax classification</p>
            </div>
            <div className="detail-panel-body">
              {renderAccountingContent()}
            </div>
          </div>
        </div>

        {/* 4B. MOBILE VIEW (<768px): Tabbed Navigation */}
        <div className="detail-mobile-tab-view mb-3">
          {/* Navigation Tabs Bar */}
          <div className="portfolio-pill-selector detail-pill-selector mb-2.5">
            <button 
              className={`portfolio-pill ${activeTab === 'txns' ? 'active' : ''}`}
              onClick={() => setActiveTab('txns')}
            >
              Transactions ({sortedTxns.length})
            </button>
            <button 
              className={`portfolio-pill ${activeTab === 'fifo' ? 'active' : ''}`}
              onClick={() => setActiveTab('fifo')}
            >
              FIFO Lots ({displayLots.length})
            </button>
            <button 
              className={`portfolio-pill ${activeTab === 'accounting' ? 'active' : ''}`}
              onClick={() => setActiveTab('accounting')}
            >
              Accounting
            </button>
          </div>

          {/* Active Tab Content for Mobile */}
          {activeTab === 'txns' && (
            <div className="portfolio-card detail-tab-card">
              <div className="mobile-txn-list">
                {sortedTxns.map((t, idx) => {
                  const txnInfo = extractTxnDetails(t, metrics.isMf);
                  const isBuy = txnInfo.isBuy;
                  const actionLbl = txnInfo.actionLbl;

                  const qtyStr = metrics.isMf 
                    ? `${txnInfo.parsedUnits.toFixed(3)} units` 
                    : `${Math.round(txnInfo.parsedUnits)} shares`;

                  const priceStr = txnInfo.parsedPrice > 0 ? `₹${txnInfo.parsedPrice.toFixed(2)}` : '—';
                  const tradeValStr = formatINR(txnInfo.parsedVal);

                  const isPosAmount = metrics.isMf ? isBuy : !isBuy;
                  const amountSign = metrics.isMf ? '+' : (isBuy ? '-' : '+');
                  const pnlClass = isPosAmount ? 'pos' : 'neg';

                  return (
                    <div key={t.rawTxn?.ID || t.id || idx} className="portfolio-card mobile-txn-card flex-between">
                      <div>
                        <div className="flex-gap-xs align-center">
                          <span className={`txn-action-tag ${isBuy ? 'buy' : 'sell'}`}>
                            {actionLbl}
                          </span>
                          <span className="txn-date text-muted font-xs num-tabular">{txnInfo.date}</span>
                        </div>
                        <div className="txn-sub-meta text-muted font-xs mt-1.5 num-tabular">
                          <span className="mono">{qtyStr}</span>
                          <span> · </span>
                          <span className="mono">{metrics.isMf ? 'NAV' : 'Price'} {priceStr}</span>
                        </div>
                      </div>
                      <div className="text-right align-self-start">
                        <div className={`txn-amount font-bold num-tabular ${pnlClass}`}>
                          {amountSign}{tradeValStr}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {activeTab === 'fifo' && (
            <div className="portfolio-card detail-tab-card">
              <div className="mobile-fifo-list">
                {displayLots.map((lot, idx) => {
                  const origUnits = lot.units !== undefined ? lot.units : (lot.qty || lot.quantity || 0);
                  const remUnits = lot.remainingUnits !== undefined ? lot.remainingUnits : 0;
                  const uCost = lot.unitCost !== undefined ? lot.unitCost : (origUnits > 0 ? lot.costBasis / origUnits : 0);

                  return (
                    <div key={lot.transactionId || idx} className="portfolio-card fifo-lot-card mb-2">
                      <div className="fifo-card-header flex-between mb-1.5">
                        <div>
                          <span className="sec-lbl text-muted uppercase">ACQUIRED</span>
                          <span className="sec-val font-bold text-primary num-tabular">{lot.date}</span>
                        </div>
                        <div className="text-right">
                          <span className="sec-lbl text-muted uppercase">COST BASIS</span>
                          <span className="sec-val font-bold num-tabular text-primary">
                            {formatINR(lot.remainingCostBasis !== undefined ? lot.remainingCostBasis : (remUnits * uCost))}
                          </span>
                        </div>
                      </div>

                      <div className="card-secondary-grid grid-3 pt-1.5 mt-1.5">
                        <div>
                          <span className="sec-lbl text-muted uppercase">ACQUIRED QTY</span>
                          <span className="sec-val font-semibold num-tabular">
                            {metrics.isMf ? origUnits.toFixed(3) : Math.round(origUnits)}
                          </span>
                        </div>
                        <div className="text-center">
                          <span className="sec-lbl text-muted uppercase">REMAINING QTY</span>
                          <span className={`sec-val font-bold num-tabular ${remUnits > 0 ? 'pos' : 'text-muted'}`}>
                            {metrics.isMf ? remUnits.toFixed(3) : Math.round(remUnits)}
                          </span>
                        </div>
                        <div className="text-right">
                          <span className="sec-lbl text-muted uppercase">{metrics.isMf ? 'ORIGINAL NAV' : 'ACQ. PRICE'}</span>
                          <span className="sec-val font-semibold num-tabular">
                            ₹{uCost.toFixed(metrics.isMf ? 2 : 2)}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {activeTab === 'accounting' && (
            <div className="portfolio-card detail-tab-card">
              {renderAccountingContent()}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
